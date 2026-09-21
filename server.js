const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
// Registrador para ver qué rutas está recibiendo el servidor
app.use((req, res, next) => {
    console.log(`[PETICIÓN RECIBIDA] Método: ${req.method} | URL: ${req.url}`);
    next();
});
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'clave_secreta_academia_vivace_2026',
    resave: false,
    saveUninitialized: false
}));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vivace2026';

let boletinAutorizado = false;

function requerirAuthAdmin(req, res, next) {
    if (req.session && req.session.esAdmin) return next();
    res.redirect('/admin/login');
}
// Añadir automáticamente la columna de mensualidad personalizada si no existe
db.run(`ALTER TABLE estudiantes ADD COLUMN mensualidad_personalizada REAL DEFAULT 10.0`, (err) => {
    if (err) {
        console.log("Nota: La columna mensualidad_personalizada ya está activa en la base de datos.");
    } else {
        console.log("¡Columna mensualidad_personalizada creada con éxito!");
    }
});
async function obtenerTasaBCVOficial() {
    return new Promise((resolve) => {
        db.get("SELECT valor FROM configuracion WHERE clave = 'tasa_bcv'", [], (err, row) => {
            if (err || !row || !row.valor) {
                resolve(814.69); // Respaldo por seguridad
            } else {
                resolve(Number(row.valor));
            }
        });
    });
}

app.use(async (req, res, next) => {
    req.tasaBCV = await obtenerTasaBCVOficial();
    res.locals.tasaBCV = req.tasaBCV;
    res.locals.boletinAutorizado = boletinAutorizado;
    next();
});

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function getMesAnioActual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getNombreMesActual() {
    const d = new Date();
    return `${MESES[d.getMonth()]} ${d.getFullYear()}`;
}

function generarEstudianteKey(nombre, email) {
    const n = (nombre || '').trim().toLowerCase();
    const e = (email || '').trim().toLowerCase();
    return `${n}__${e}`;
}
const multer = require('multer');
// Ruta para actualizar los datos del estudiante
app.post('/admin/editar-estudiante', requerirAuthAdmin, (req, res) => {
    const { id_estudiante, nombre_estudiante, telefono_representante, email_representante, mensualidad_personalizada, exonerado } = req.body;

    db.run(
        `UPDATE estudiantes SET nombre_estudiante = ?, telefono_representante = ?, email_representante = ?, mensualidad_personalizada = ?, exonerado = ? WHERE id = ?`,
        [nombre_estudiante, telefono_representante, email_representante, mensualidad_personalizada, exonerado, id_estudiante],
        (err) => {
            if (err) {
                console.error("Error al actualizar estudiante:", err.message);
            }
            res.redirect('/admin');
        }
    );
});

// Configuración de almacenamiento para fotos de estudiantes
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'public', 'uploads')); // Carpeta donde se guardarán
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'estudiante-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
app.get('/', (req, res) => {
    if (req.session && req.session.esAdmin) {
        return res.redirect('/admin');
    }
    res.render('index', { error: null }); // <--- ¡Aquí está la clave!
});

app.post('/representante/login', (req, res) => {
    const { busqueda } = req.body;
    const busquedaClean = (busqueda || '').trim();
    if (!busquedaClean) return res.render('index', { error: 'Por favor ingrese una cédula o correo válido.' });

    db.all(`SELECT * FROM estudiantes WHERE email_representante = ? OR cedula_representante = ?`, [busquedaClean, busquedaClean], (err, estudiantes) => {
        if (err || !estudiantes || estudiantes.length === 0) {
            return res.render('index', { error: 'No se encontraron estudiantes asociados a este representante.' });
        }
        const ids = estudiantes.map(e => e.id);
        const placeholders = ids.map(() => '?').join(',');

        db.all(`SELECT * FROM cobros WHERE id_estudiante IN (${placeholders}) ORDER BY id DESC`, ids, (err, cobros) => {
            if (err) cobros = [];
            
            db.all(`SELECT * FROM asistencia_clases`, [], (err, todasAsistencias) => {
                if (err) todasAsistencias = [];
                db.all(`SELECT * FROM calificaciones`, [], (err, todasCalificaciones) => {
                    if (err) todasCalificaciones = [];
                    db.all(`SELECT * FROM solsitos`, [], (err, todosSolsitos) => {
                        if (err) todosSolsitos = [];

                        const estudiantesProcesados = estudiantes.map(est => {
                            const misCobros = cobros.filter(c => Number(c.id_estudiante) === Number(est.id));
                            const pendienteUSD = misCobros.filter(c => c.estatus === 'Pendiente' || c.estatus === 'Revision').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                            const solvente = est.exonerado === 1 || pendienteUSD <= 0;
                            const estKey = generarEstudianteKey(est.nombre_estudiante, est.email_representante);

                            const misAsistencias = solvente ? todasAsistencias.filter(a => a.estudiante_key === estKey) : [];
                            const misCalificaciones = solvente ? todasCalificaciones.filter(cl => cl.estudiante_key === estKey) : [];
                            const misSolsitos = solvente ? todosSolsitos.filter(s => s.estudiante_key === estKey) : [];

                            const catedrasAlumno = ['Coro', 'Lenguaje Musical', 'Ensayo'];
                            if (est.instrumento && !catedrasAlumno.includes(est.instrumento)) {
                                catedrasAlumno.push(est.instrumento);
                            }

                            const resumenAsistenciaPorCatedra = {};
                            catedrasAlumno.forEach(cat => {
                                const registrosCat = misAsistencias.filter(a => (a.catedra || '').toLowerCase().includes(cat.toLowerCase()));
                                const totalClases = registrosCat.length;
                                const totalPresente = registrosCat.filter(a => a.estado === 'Presente').length;
                                resumenAsistenciaPorCatedra[cat] = {
                                    presente: totalPresente,
                                    total: totalClases,
                                    registros: registrosCat
                                };
                            });

                            return {
                                ...est,
                                estKey,
                                cobrosHistorial: misCobros,
                                asistenciasHistorial: misAsistencias,
                                calificacionesHistorial: misCalificaciones,
                                solsitosHistorial: misSolsitos,
                                catedrasAlumno,
                                resumenAsistenciaPorCatedra,
                                solvente
                            };
                        });
                        res.render('representante_portal', { estudiantes: estudiantesProcesados, tasaBCV: req.tasaBCV, boletinAutorizado });
                    });
                });
            });
        });
    });
});

app.post('/representante/registrar', (req, res) => {
    const nombre = (req.body.nombre_estudiante || '').trim();
    const cedulaEst = (req.body.cedula_estudiante || '').trim();
    const fechaNac = req.body.fecha_nacimiento || null;
    const edad = req.body.edad ? parseInt(req.body.edad) : null;
    const tipoSangre = (req.body.tipo_sangre || '').trim();
    
    const rep = (req.body.nombre_representante || '').trim();
    const cedulaRep = (req.body.cedula_representante || '').trim();
    const telfRep = (req.body.telefono_representante || '').trim();
    const correo = (req.body.email_representante || '').trim();
    
    const instrumento = req.body.instrumento || 'CUATRO';
    const nivel = req.body.nivel || 'INFANTIL';

    if (!nombre || !rep || !telfRep || !correo || !instrumento) {
        return res.status(400).send("Faltan campos obligatorios para completar el registro.");
    }

    const codigo_qr = 'vivace-' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    const query = `INSERT INTO estudiantes (
        nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, 
        nombre_representante, cedula_representante, telefono_representante, email_representante, 
        instrumento, nivel, codigo_qr, exonerado
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;

    db.run(query, [
        nombre, cedulaEst, fechaNac, edad, tipoSangre,
        rep, cedulaRep, telfRep, correo,
        instrumento, nivel, codigo_qr
    ], function(err) {
        if (err) {
            console.error("❌ Error al autoregistrar estudiante:", err.message);
            return res.status(500).send("Error al guardar el registro: " + err.message);
        }

        const nuevoId = this.lastID;
        const mesAnioInscripcion = getMesAnioActual(); 
        const nombreMesInscripcion = getNombreMesActual();

        db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 5.00, ?, 'Pendiente')`, 
        [nuevoId, 'Inscripción del Año Escolar', mesAnioInscripcion], () => {
            db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 10.00, ?, 'Pendiente')`, 
            [nuevoId, `Mensualidad ${nombreMesInscripcion}`, mesAnioInscripcion], () => {
                const mensajeNotif = `Nuevo estudiante registrado: ${nombre} (${instrumento} - ${nivel}) por el representante ${rep}.`;
                db.run(`INSERT INTO solsitos (estudiante_key, id_personal, cantidad, motivo, periodo) VALUES (?, 1, 0, ?, ?)`, 
                [generarEstudianteKey(nombre, correo), mensajeNotif, nombreMesInscripcion], () => {
                    res.redirect('/representante/portal/' + nuevoId);
                });
            });
        });
    });
});

app.post('/representante/reportar-pago-multiple', (req, res) => {
    const idEstudiante = req.body.id_estudiante;
    let cobrosSeleccionados = req.body.cobros_seleccionados;
    const comprobante = (req.body.comprobante || '').trim();

    if (!cobrosSeleccionados || !comprobante) {
        return res.status(400).send("Error: Debe seleccionar al menos un concepto y colocar el número de referencia del pago móvil.");
    }

    if (!Array.isArray(cobrosSeleccionados)) {
        cobrosSeleccionados = [cobrosSeleccionados];
    }

    let completados = 0;
    let errorOcurrido = false;

    cobrosSeleccionados.forEach(idCobro => {
        db.run(
            `UPDATE cobros SET estatus = 'Revision', comprobante = ? WHERE id = ? AND id_estudiante = ?`,
            [comprobante, idCobro, idEstudiante],
            (err) => {
                if (err) errorOcurrido = true;
                completados++;

                if (completados === cobrosSeleccionados.length) {
                    if (errorOcurrido) {
                        return res.status(500).send("Ocurrió un error al procesar el reporte múltiple.");
                    }
                    res.redirect('/representante/portal/' + idEstudiante);
                }
            }
        );
    });
});

app.get('/representante/portal/:id', (req, res) => {
    const idEstudiante = req.params.id;
    db.get(`SELECT * FROM estudiantes WHERE id = ?`, [idEstudiante], (err, estudiante) => {
        if (err || !estudiante) return res.redirect('/');
        db.all(`SELECT * FROM estudiantes WHERE email_representante = ?`, [estudiante.email_representante], (err, hermanos) => {
            const listaEstudiantes = (hermanos && hermanos.length > 0) ? hermanos : [estudiante];
            const ids = listaEstudiantes.map(e => e.id);
            const placeholders = ids.map(() => '?').join(',');

            db.all(`SELECT * FROM cobros WHERE id_estudiante IN (${placeholders}) ORDER BY id DESC`, ids, (err, cobros) => {
                if (err) cobros = [];
                db.all(`SELECT * FROM asistencia_clases`, [], (err, todasAsistencias) => {
                    if (err) todasAsistencias = [];
                    db.all(`SELECT * FROM calificaciones`, [], (err, todasCalificaciones) => {
                        if (err) todasCalificaciones = [];
                        db.all(`SELECT * FROM solsitos`, [], (err, todosSolsitos) => {
                            if (err) todosSolsitos = [];

                            const estudiantesProcesados = listaEstudiantes.map(e => {
                                const misCobros = cobros.filter(c => Number(c.id_estudiante) === Number(e.id));
                                const pendienteUSD = misCobros.filter(c => c.estatus === 'Pendiente' || c.estatus === 'Revision').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                                const solvente = e.exonerado === 1 || pendienteUSD <= 0;
                                const estKey = generarEstudianteKey(e.nombre_estudiante, e.email_representante);

                                const misAsistencias = solvente ? todasAsistencias.filter(a => a.estudiante_key === estKey) : [];
                                const misCalificaciones = solvente ? todasCalificaciones.filter(cl => cl.estudiante_key === estKey) : [];
                                const misSolsitos = solvente ? todosSolsitos.filter(s => s.estudiante_key === estKey) : [];

                                const catedrasAlumno = ['Coro', 'Lenguaje Musical', 'Ensayo'];
                                if (e.instrumento && !catedrasAlumno.includes(e.instrumento)) {
                                    catedrasAlumno.push(e.instrumento);
                                }

                                const resumenAsistenciaPorCatedra = {};
                                catedrasAlumno.forEach(cat => {
                                    const registrosCat = misAsistencias.filter(a => (a.catedra || '').toLowerCase().includes(cat.toLowerCase()));
                                    resumenAsistenciaPorCatedra[cat] = {
                                        presente: registrosCat.filter(a => a.estado === 'Presente').length,
                                        total: registrosCat.length,
                                        registros: registrosCat
                                    };
                                });

                                return {
                                    ...e,
                                    estKey,
                                    cobrosHistorial: misCobros,
                                    asistenciasHistorial: misAsistencias,
                                    calificacionesHistorial: misCalificaciones,
                                    solsitosHistorial: misSolsitos,
                                    catedrasAlumno,
                                    resumenAsistenciaPorCatedra,
                                    solvente
                                };
                            });
                            res.render('representante_portal', { estudiantes: estudiantesProcesados, tasaBCV: req.tasaBCV, boletinAutorizado });
                        });
                    });
                });
            });
        });
    });
});

const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.get('/representante/boletin/:id', async (req, res) => {
    if (!boletinAutorizado) {
        return res.status(403).send("Los boletines se encuentran bloqueados temporalmente por la dirección.");
    }
    const idEstudiante = req.params.id;
    
    db.get(`SELECT * FROM estudiantes WHERE id = ?`, [idEstudiante], async (err, estudiante) => {
        if (err || !estudiante) return res.status(404).send("Estudiante no encontrado.");

        const estKey = generarEstudianteKey(estudiante.nombre_estudiante, estudiante.email_representante);

        db.all(`SELECT * FROM calificaciones WHERE estudiante_key = ?`, [estKey], async (err, calificaciones) => {
            if (err) calificaciones = [];
            db.all(`SELECT * FROM asistencia_clases WHERE estudiante_key = ?`, [estKey], async (err, asistencias) => {
                if (err) asistencias = [];

                const calificacionesAgrupadas = {};
                calificaciones.forEach(c => {
                    const cat = c.catedra || 'General';
                    if (!calificacionesAgrupadas[cat]) calificacionesAgrupadas[cat] = [];
                    calificacionesAgrupadas[cat].push(c);
                });

                const asistenciaMapa = {};
                asistencias.forEach(a => {
                    const cat = a.catedra || 'General';
                    if (!asistenciaMapa[cat]) asistenciaMapa[cat] = { totalClases: 0, totalPresentes: 0 };
                    asistenciaMapa[cat].totalClases += 1;
                    if (a.estado === 'Presente') asistenciaMapa[cat].totalPresentes += 1;
                });

                const asistenciaResumen = Object.keys(asistenciaMapa).map(cat => ({
                    catedra: cat,
                    totalClases: asistenciaMapa[cat].totalClases,
                    totalPresentes: asistenciaMapa[cat].totalPresentes
                }));

                let observacionIA = "Estudiante destacado por su excelente compromiso y evolución en la academia.";
                try {
                    const prompt = `Actúa como el director de la Academia de Música Vivace. Escribe una observación académica formal, motivadora, elegante y personalizada para el boletín del estudiante ${estudiante.nombre_estudiante}, quien cursa la especialidad de ${estudiante.instrumento || 'Música'}. Calificaciones: ${JSON.stringify(calificaciones)} y asistencia: ${JSON.stringify(asistenciaResumen)}.`;
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: prompt,
                    });
                    if (response && response.text) observacionIA = response.text.trim();
                } catch (error) {
                    console.error("⚠️ Error generando observación con IA:", error.message);
                }

                res.render('boletin_pdf', {
                    estudiante: { ...estudiante, calificacionesAgrupadas, asistenciaResumen, observacionIA },
                    tasaBCV: req.tasaBCV
                });
            });
        });
    });
});

app.get('/carnet/:codigo_qr', (req, res) => {
    db.get(`SELECT * FROM estudiantes WHERE codigo_qr = ?`, [req.params.codigo_qr], (err, estudiante) => {
        if (err || !estudiante) return res.status(404).send("Carnet no encontrado.");

        db.all(`SELECT * FROM cobros WHERE id_estudiante = ? ORDER BY id DESC`, [estudiante.id], (err, cobros) => {
            if (err) cobros = [];
            const cobrosPendientes = cobros.filter(c => c.estatus === 'Pendiente' || c.estatus === 'Revision');
            const estatusCarnet = estudiante.exonerado === 1 ? 'ACTIVO (EXONERADO)' : (cobrosPendientes.length > 3 ? 'INACTIVO (MOROSO)' : 'ACTIVO');

            res.render('carnet_publico', { estudiante, tasaBCV: req.tasaBCV, estatusCarnet });
        });
    });
});

app.get('/docente/login', (req, res) => {
    res.render('docente_login', { error: null });
});

app.post('/docente/login', (req, res) => {
    db.get(`SELECT * FROM personal WHERE email = ?`, [(req.body.email || '').trim()], (err, miembro) => {
        if (err || !miembro) return res.render('docente_login', { error: 'Correo no registrado en la nómina.' });
        
        const cargoLower = (miembro.cargo || '').toLowerCase();
        if (cargoLower.includes('secretaria') || cargoLower.includes('administrativo') || cargoLower.includes('administracion')) {
            return res.redirect('/personal-administrativo/portal/' + miembro.id);
        }
        res.redirect('/docente/portal/' + miembro.id);
    });
});

app.get('/personal-administrativo/portal/:id', (req, res) => {
    const idPersonal = req.params.id;
    const tasaBCV = req.tasaBCV;

    db.get(`SELECT * FROM personal WHERE id = ?`, [idPersonal], (err, miembro) => {
        if (err || !miembro) return res.status(404).send("Personal no encontrado.");

        db.all(`SELECT * FROM pagos_personal WHERE id_personal = ? ORDER BY fecha_pago DESC`, [idPersonal], (err, pagos) => {
            if (err) pagos = [];
            const sueldoBaseVES = parseFloat(miembro.sueldo_base_ves) || 0;
            const alimentacionBs = (parseFloat(miembro.bono_alimentacion_usd) || 0) * tasaBCV;
            const transporteBs = (parseFloat(miembro.bono_transporte_usd) || 0) * tasaBCV;
            const totalBrutoVES = sueldoBaseVES + alimentacionBs + transporteBs;
            const totalPagadoVES = pagos.reduce((acc, p) => acc + (p.monto_ves || 0), 0);
            const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoVES);

            res.render('admin_personal_portal', {
                miembro, tasaBCV, pagos, sueldoBaseVES, bonoAlimentacionUSD: miembro.bono_alimentacion_usd, alimentacionBs, bonoTransporteUSD: miembro.bono_transporte_usd, transporteBs, totalBrutoVES, totalPagadoVES, saldoPendienteVES
            });
        });
    });
});

app.get('/docente/portal/:id', (req, res) => {
    const idDocente = req.params.id;
    const tasaBCV = req.tasaBCV;

    db.get(`SELECT * FROM personal WHERE id = ?`, [idDocente], (err, docente) => {
        if (err || !docente) return res.status(404).send("Docente no encontrado.");

        db.all(`SELECT * FROM pagos_personal WHERE id_personal = ? ORDER BY fecha_pago DESC`, [idDocente], (err, pagos) => {
            if (err) pagos = [];
            
            const sueldoBaseVES = parseFloat(docente.sueldo_base_ves) || 0;
            const alimentacionBs = (parseFloat(docente.bono_alimentacion_usd) || 0) * tasaBCV;
            const transporteBs = (parseFloat(docente.bono_transporte_usd) || 0) * tasaBCV;
            const totalBrutoVES = sueldoBaseVES + alimentacionBs + transporteBs;
            const totalPagadoVES = pagos.reduce((acc, p) => acc + (p.monto_ves || 0), 0);
            const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoVES);

            db.all(`SELECT * FROM estudiantes ORDER BY nivel ASC, nombre_estudiante ASC`, [], (err, todosEstudiantes) => {
                if (err) todosEstudiantes = [];

                const nombreDocente = docente.nombre_empleado || 'Docente';
                const instDocenteRaw = docente.cargo || docente.instrumento || docente.especialidad || '';
                const limpiarTexto = (texto) => (texto || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
                const instrumentoDocente = limpiarTexto(instDocenteRaw);

                const estudiantesFiltrados = todosEstudiantes.filter(est => {
                    if (instrumentoDocente.includes('CORO') || instrumentoDocente.includes('LENGUAJE')) return true;
                    if (!instrumentoDocente) return true;
                    const instEstudiante = limpiarTexto(est.instrumentos_multiples || est.instrumento || est.curso || '');
                    return instEstudiante.includes(instrumentoDocente) || instrumentoDocente.includes(instEstudiante);
                });

                db.all(`SELECT * FROM asistencia_clases WHERE id_personal = ? ORDER BY fecha DESC`, [idDocente], (err, misAsistencias) => {
                    if (err) misAsistencias = [];
                    db.all(`SELECT * FROM calificaciones WHERE id_personal = ? ORDER BY id DESC`, [idDocente], (err, misCalificaciones) => {
                        if (err) misCalificaciones = [];
                        db.all(`SELECT * FROM solsitos ORDER BY id DESC`, [], (err, todosSolsitos) => {
                            if (err) todosSolsitos = [];

                            const estudiantesConPuntos = estudiantesFiltrados.map(est => {
                                const estKey = generarEstudianteKey(est.nombre_estudiante, est.email_representante);
                                const misSolsitos = todosSolsitos.filter(s => s.estudiante_key === estKey);
                                const totalSolsitos = misSolsitos.filter(s => (s.cantidad || 0) > 0).reduce((acc, s) => acc + s.cantidad, 0);
                                const totalSilencios = misSolsitos.filter(s => (s.cantidad || 0) < 0).reduce((acc, s) => acc + Math.abs(s.cantidad), 0);
                                return { ...est, estKey, totalSolsitos, totalSilencios, historialSolsitos: misSolsitos };
                            });

                            res.render('docente_portal', { 
                                docente, tasaBCV, pagos, estudiantes: estudiantesConPuntos, misAsistencias, misCalificaciones, sueldoBaseVES, bonoAlimentacionUSD: docente.bono_alimentacion_usd, alimentacionBs, bonoTransporteUSD: docente.bono_transporte_usd, transporteBs, totalBrutoVES, totalPagadoVES, saldoPendienteVES 
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/docente/guardar-asistencia-grupal', (req, res) => {
    const { id_personal, catedra, fecha, asistencia } = req.body;
    if (!asistencia) return res.redirect('/docente/portal/' + id_personal);
    const entries = Object.entries(asistencia);
    
    function procesarSiguiente(index) {
        if (index >= entries.length) return res.redirect('/docente/portal/' + id_personal);
        const [estKey, estado] = entries[index];
        if (!estKey || !estado) return procesarSiguiente(index + 1);

        db.get(`SELECT id FROM asistencia_clases WHERE estudiante_key = ? AND fecha = ? AND catedra = ?`, [estKey, fecha, catedra], (err, row) => {
            if (row) {
                db.run(`UPDATE asistencia_clases SET estado = ? WHERE id = ?`, [estado, row.id], () => procesarSiguiente(index + 1));
            } else {
                db.run(`INSERT INTO asistencia_clases (estudiante_key, id_personal, catedra, fecha, estado) VALUES (?, ?, ?, ?, ?)`, 
                [estKey, id_personal, catedra, fecha, estado], () => procesarSiguiente(index + 1));
            }
        });
    }
    procesarSiguiente(0);
});

app.post('/docente/guardar-notas-masivas', (req, res) => {
    const { id_personal, periodo, catedra, objetivo, indicador, notas, observaciones } = req.body;
    if (!notas) return res.redirect('/docente/portal/' + id_personal);
    const entriesNotas = Object.entries(notas);

    function procesarSiguienteNota(index) {
        if (index >= entriesNotas.length) return res.redirect('/docente/portal/' + id_personal);
        const [estKey, calificacion] = entriesNotas[index];
        const observacion = (observaciones && observaciones[estKey]) ? observaciones[estKey] : '';
        if (!estKey || !calificacion || String(calificacion).trim() === '') return procesarSiguienteNota(index + 1);

        db.get(`SELECT id FROM calificaciones WHERE estudiante_key = ? AND catedra = ? AND objetivo = ?`, [estKey, catedra, objetivo], (err, row) => {
            if (row) {
                db.run(`UPDATE calificaciones SET periodo = ?, indicador = ?, calificacion = ?, observacion = ? WHERE id = ?`, 
                [periodo, indicador, calificacion, observacion, row.id], () => procesarSiguienteNota(index + 1));
            } else {
                db.run(`INSERT INTO calificaciones (estudiante_key, id_personal, periodo, catedra, objetivo, indicador, calificacion, observacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                [estKey, id_personal, periodo, catedra, objetivo, indicador, calificacion, observacion], () => procesarSiguienteNota(index + 1));
            }
        });
    }
    procesarSiguienteNota(0);
});

app.post('/docente/guardar-solsito-individual', (req, res) => {
    const { id_personal, estudiante_key, tipo_punto, cantidad, motivo, periodo } = req.body;
    const valorNum = parseInt(cantidad) || 1;
    const cantidadFinal = tipo_punto === 'negativo' ? -Math.abs(valorNum) : Math.abs(valorNum);
    const motivoFinal = motivo || (tipo_punto === 'negativo' ? 'Silencio de negra' : 'Solsito ganado');

    db.run(`INSERT INTO solsitos (estudiante_key, id_personal, cantidad, motivo, periodo) VALUES (?, ?, ?, ?, ?)`, 
    [estudiante_key, id_personal, cantidadFinal, motivoFinal, periodo || getNombreMesActual()], () => {
        res.redirect('/docente/portal/' + id_personal);
    });
});

app.get('/admin/login', (req, res) => {
    if (req.session && req.session.esAdmin) return res.redirect('/admin');
    res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.esAdmin = true;
        res.redirect('/admin');
    } else {
        res.render('admin_login', { error: 'Contraseña incorrecta.' });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

app.post('/admin/toggle-boletin', requerirAuthAdmin, (req, res) => {
    boletinAutorizado = !boletinAutorizado;
    res.redirect('/admin');
});

app.post('/admin/actualizar-tasa', requerirAuthAdmin, (req, res) => {
    const { tasa } = req.body;
    if (tasa) {
        db.run(`UPDATE configuracion SET valor = ? WHERE clave = 'tasa_bcv'`, [tasa], function(err) {
            if (err || this.changes === 0) {
                db.run(`INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('tasa_bcv', ?)`, [tasa], () => {
                    res.redirect('/admin');
                });
            } else {
                res.redirect('/admin');
            }
        });
    } else {
        res.redirect('/admin');
    }
});

// Ruta principal del Panel Admin totalmente unificada
app.get('/admin', requerirAuthAdmin, (req, res) => {
    try {
        const tasaBCV = req.tasaBCV || 814.69;
        const mesAnioActual = getMesAnioActual();
        const nombreMesActual = getNombreMesActual();

        db.all(`SELECT * FROM estudiantes`, [], (err, estudiantes) => {
            if (err || !estudiantes) estudiantes = [];
            db.all(`SELECT * FROM cobros`, [], (err, cobros) => {
                if (err || !cobros) cobros = [];

                estudiantes.forEach(est => {
            if (est.exonerado !== 1) {
                const tieneCobroMes = cobros.some(c => c.id_estudiante === est.id && c.mes_anio === mesAnioActual && c.concepto && c.concepto.includes('Mensualidad'));
                if (!tieneCobroMes) {
                    // Usamos la mensualidad personalizada del alumno o 10.00 por defecto
                    const montoMensualidad = (est.mensualidad_personalizada !== null && est.mensualidad_personalizada !== undefined) ? est.mensualidad_personalizada : 10.00;

                    db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, ?, ?, 'Pendiente')`, [est.id, `Mensualidad ${nombreMesActual}`, montoMensualidad, mesAnioActual]);
                }
            }
        });

                const estudiantesProcesados = estudiantes.map(est => {
                    const misCobros = cobros.filter(c => c.id_estudiante === est.id);
                    const pagadoUSD = misCobros.filter(c => c.estatus === 'Pagado').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                    const pendienteUSD = misCobros.filter(c => c.estatus === 'Pendiente' || c.estatus === 'Revision').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                    const estaAlDia = est.exonerado === 1 || pendienteUSD === 0;
                    return { ...est, estaAlDia, deudaUSD: pendienteUSD, pagadoUSD, cobrosHistorial: misCobros };
                });

                db.all(`SELECT * FROM egresos ORDER BY id DESC`, [], (err, egresos) => {
                    if (err || !egresos) egresos = [];
                    const totalEgresosVES = egresos.reduce((acc, e) => acc + (e.monto_ves || 0), 0);
                    const totalEgresosUSD = egresos.reduce((acc, e) => acc + (e.monto_usd || 0), 0);
                    const totalIvaCreditoVES = egresos.reduce((acc, e) => acc + (e.monto_iva_ves || 0), 0);

                    const cobrosPagados = cobros.filter(c => c.estatus === 'Pagado');
                    const totalIngresosUSD = cobrosPagados.reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                    const totalIngresosVES = totalIngresosUSD * tasaBCV;
                    const totalIvaDebitoVES = 0.00;

                    const saldoCajaUSD = Math.max(0, totalIngresosUSD - totalEgresosUSD);

                    const mapaCobrosRevision = {};
                    cobros.filter(c => c.estatus === 'Revision').forEach(c => {
                        const clave = `${c.id_estudiante}_${(c.comprobante || 'S/N').trim()}`;
                        if (!mapaCobrosRevision[clave]) {
                            const est = estudiantes.find(e => e.id === c.id_estudiante);
                            mapaCobrosRevision[clave] = {
                                id_estudiante: c.id_estudiante,
                                comprobante: c.comprobante,
                                ids_cobros: [],
                                conceptos: [],
                                total_usd: 0,
                                nombre_estudiante: est ? est.nombre_estudiante : 'Desconocido',
                                nombre_representante: est ? est.nombre_representante : 'N/A',
                                telefono_representante: est ? est.telefono_representante : ''
                            };
                        }
                        mapaCobrosRevision[clave].ids_cobros.push(c.id);
                        mapaCobrosRevision[clave].conceptos.push(c.concepto);
                        mapaCobrosRevision[clave].total_usd += (c.monto_usd || 0);
                    });

                    const cobrosPorRevisar = Object.values(mapaCobrosRevision).map(item => ({
                        ...item,
                        concepto_unido: item.conceptos.join(' + ')
                    }));

                    db.all(`SELECT * FROM personal`, [], (err, personalList) => {
                        if (err || !personalList) personalList = [];
                        db.all(`SELECT * FROM pagos_personal ORDER BY fecha_pago DESC`, [], (err, pagosList) => {
                            if (err || !pagosList) pagosList = [];
                            
                            db.all(`SELECT a.*, COALESCE(e.nombre_estudiante, 'Estudiante') AS nombre_estudiante FROM asistencia_clases a LEFT JOIN estudiantes e ON a.estudiante_key = (LOWER(TRIM(e.nombre_estudiante)) || '__' || LOWER(TRIM(e.email_representante))) ORDER BY a.fecha DESC`, [], (err, todasAsistencias) => {
                                if (err) todasAsistencias = [];
                                db.all(`SELECT c.*, COALESCE(e.nombre_estudiante, 'Estudiante') AS nombre_estudiante FROM calificaciones c LEFT JOIN estudiantes e ON c.estudiante_key = (LOWER(TRIM(e.nombre_estudiante)) || '__' || LOWER(TRIM(e.email_representante))) ORDER BY c.id DESC`, [], (err, todasCalificaciones) => {
                                    if (err) todasCalificaciones = [];

                                    let totalNominaRequeridaVES = 0;
                                    let totalNominaPagadaVES = 0;
                                    const personalProcesado = personalList.map(p => {
                                        const sueldoBase = parseFloat(p.sueldo_base_ves) || 0;
                                        const alimentacionBs = (parseFloat(p.bono_alimentacion_usd) || 0) * tasaBCV;
                                        const transporteBs = (parseFloat(p.bono_transporte_usd) || 0) * tasaBCV;
                                        const totalBrutoVES = sueldoBase + alimentacionBs + transporteBs;

                                        const misPagosMes = pagosList.filter(pg => pg.id_personal === p.id && pg.periodo_quincena === mesAnioActual);
                                        const sueldoPagado = misPagosMes.filter(pg => pg.tipo_pago === 'SUELDO_BASE').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);
                                        const alimentacionPagada = misPagosMes.filter(pg => pg.tipo_pago === 'CESTA_TICKET').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);
                                        const transportePagado = misPagosMes.filter(pg => pg.tipo_pago === 'TRANSPORTE').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);

                                        const totalPagadoMes = sueldoPagado + alimentacionPagada + transportePagado;
                                        totalNominaPagadaVES += totalPagadoMes;

                                        const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoMes);
                                        totalNominaRequeridaVES += saldoPendienteVES;

                                        return {
                                            ...p,
                                            totalBrutoVES,
                                            saldoPendienteVES,
                                            sueldoCompleto: sueldoPagado >= (sueldoBase - 1),
                                            alimentacionCompleta: alimentacionPagada >= (alimentacionBs - 1),
                                            transporteCompleto: transportePagado >= (transporteBs - 1),
                                            historialPagos: misPagosMes
                                        };
                                    });

                                    const totalNominaRequeridaUSD = totalNominaRequeridaVES / tasaBCV;
                                    const cajaCubreNomina = saldoCajaUSD >= totalNominaRequeridaUSD;

                                    res.render('admin', {
                                        tasaBCV,
                                        boletinAutorizado,
                                        estudiantes: estudiantesProcesados,
                                        egresos,
                                        totalIngresosVES: totalIngresosVES || 0,
                                        totalIngresosUSD: totalIngresosUSD || 0,
                                        totalEgresosVES: totalEgresosVES || 0,
                                        totalEgresosUSD: totalEgresosUSD || 0,
                                        totalNominaPagadaVES: totalNominaPagadaVES || 0,
                                        totalIvaDebitoVES: totalIvaDebitoVES || 0,
                                        totalIvaCreditoVES: totalIvaCreditoVES || 0,
                                        cobrosPorRevisar: cobrosPorRevisar || [],
                                        personal: personalProcesado || [],
                                        todasAsistencias: todasAsistencias || [],
                                        todasCalificaciones: todasCalificaciones || [],
                                        totalNominaRequeridaVES: totalNominaRequeridaVES || 0,
                                        totalNominaRequeridaUSD: totalNominaRequeridaUSD || 0,
                                        saldoCajaUSD: saldoCajaUSD || 0,
                                        cajaCubreNomina: cajaCubreNomina || false,
                                        nombreMesActual: nombreMesActual || ''
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    } catch (e) {
        console.error("Error en /admin:", e);
        res.status(500).send("Error interno en panel admin.");
    }
});

app.post('/admin/modificar-asistencia', requerirAuthAdmin, (req, res) => {
    const { id_asistencia, estado } = req.body;
    db.run(`UPDATE asistencia_clases SET estado = ? WHERE id = ?`, [estado, id_asistencia], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/modificar-calificacion', requerirAuthAdmin, (req, res) => {
    const { id_calificacion, calificacion, observacion } = req.body;
    db.run(`UPDATE calificaciones SET calificacion = ?, observacion = ? WHERE id = ?`, [calificacion, observacion, id_calificacion], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/agregar-estudiante', requerirAuthAdmin, (req, res) => {
    const nombre = (req.body.nombre_estudiante || '').trim();
    const cedulaEstudiante = (req.body.cedula_estudiante || '').trim();
    const fechaNacimiento = req.body.fecha_nacimiento || null;
    const edad = req.body.edad ? parseInt(req.body.edad) : null;
    const tipoSangre = (req.body.tipo_sangre || '').trim();
    const direccion = (req.body.direccion || '').trim();
    const foto = (req.body.foto || '/img/logo_vivace.png').trim();
    
    const rep = (req.body.nombre_representante || '').trim();
    const cedulaRep = (req.body.cedula_representante || '').trim();
    const telefonoRep = (req.body.telefono_representante || '').trim();
    const parentesco = (req.body.parentesco || '').trim();
    const correo = (req.body.email_representante || '').trim();
    
    const nivel = (req.body.nivel || '').trim() || 'INFANTIL';
    const obsMedicas = (req.body.observaciones_medicas || '').trim();
    const exoneradoVal = req.body.exonerado ? 1 : 0;

    if (!nombre || !rep || !correo) {
        return res.status(400).send("Error: El nombre del estudiante, el representante y el correo son obligatorios.");
    }

    let instrumentosSeleccionados = req.body.instrumentos_multiples;
    let instrumentoFinal = 'GENERAL';
    if (instrumentosSeleccionados) {
        instrumentoFinal = Array.isArray(instrumentosSeleccionados) ? instrumentosSeleccionados.join(', ') : String(instrumentosSeleccionados);
    }

    const codigo_qr = 'vivace-' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    db.run(
        `INSERT INTO estudiantes (
            nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, direccion, foto,
            nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante,
            instrumento, nivel, observaciones_medicas, codigo_qr, exonerado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [nombre, cedulaEstudiante, fechaNacimiento, edad, tipoSangre, direccion, foto, rep, cedulaRep, telefonoRep, parentesco, correo, instrumentoFinal, nivel, obsMedicas, codigo_qr, exoneradoVal],
        function(err) {
            if (err) return res.status(500).send("Error de base de datos: " + err.message);
            res.redirect('/admin');
        }
    );
});

app.post('/admin/eliminar-estudiante', requerirAuthAdmin, (req, res) => {
    const { id_estudiante } = req.body;
    db.run(`DELETE FROM cobros WHERE id_estudiante = ?`, [id_estudiante], () => {
        db.run(`DELETE FROM estudiantes WHERE id = ?`, [id_estudiante], () => {
            res.redirect('/admin');
        });
    });
});

app.post('/admin/agregar-cobro-estudiante', requerirAuthAdmin, (req, res) => {
    db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, ?, ?, 'Pendiente')`, [req.body.id_estudiante, req.body.concepto, parseFloat(req.body.monto_usd) || 0, getMesAnioActual()], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/registrar-pago-historico', requerirAuthAdmin, (req, res) => {
    const { id_cobro, monto_usd, comprobante, inputMontoExactoVes } = req.body;
    let montoUsdNum = parseFloat(monto_usd) || 0;

    if (inputMontoExactoVes && parseFloat(inputMontoExactoVes) > 0) {
        const montoVesExacto = parseFloat(inputMontoExactoVes);
        if (montoUsdNum <= 0 && req.tasaBCV > 0) {
            montoUsdNum = Number((montoVesExacto / req.tasaBCV).toFixed(2));
        }
    }

    db.run(`UPDATE cobros SET monto_usd = ?, estatus = 'Pagado', comprobante = ? WHERE id = ?`, 
    [montoUsdNum, comprobante, id_cobro], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/agregar-egreso', requerirAuthAdmin, (req, res) => {
    const { proveedor, rif, numero_factura, numero_control, concepto, monto_ves, fecha_egreso, monto_usd, tiene_factura } = req.body;
    const monto_ves_num = parseFloat(monto_ves) || 0;
    const tieneFacturaBool = parseInt(tiene_factura) === 1;
    const fechaCompra = fecha_egreso || new Date().toISOString().substring(0, 10);
    
    let baseImponible = tieneFacturaBool ? monto_ves_num / 1.16 : 0;
    let montoIva = tieneFacturaBool ? monto_ves_num - baseImponible : 0;
    let montoExento = tieneFacturaBool ? 0 : monto_ves_num;

    db.run(`INSERT INTO egresos (proveedor, rif, numero_factura, numero_control, concepto, monto_ves, fecha_egreso, monto_exento_ves, base_imponible_ves, monto_iva_ves, monto_usd, tiene_factura) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [proveedor, rif, numero_factura, numero_control, concepto, monto_ves_num, fechaCompra, montoExento, baseImponible, montoIva, parseFloat(monto_usd) || 0, tieneFacturaBool ? 1 : 0], () => {
        res.redirect('/admin');
    });
});

app.get('/admin/exportar-libro-compras', requerirAuthAdmin, (req, res) => {
    db.all(`SELECT * FROM egresos ORDER BY fecha_egreso ASC`, [], (err, egresos) => {
        if (err) return res.status(500).send("Error");
        let csv = "\uFEFFOp,Fecha,RIF,Proveedor,Factura,Control,Total,Exentas,Base,IVA\n";
        egresos.forEach((e, i) => {
            csv += `${i + 1},${e.fecha_egreso},"${e.rif}","${e.proveedor}","${e.numero_factura}","${e.numero_control}",${e.monto_ves},${e.monto_exento_ves},${e.base_imponible_ves},${e.monto_iva_ves}\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="Libro_Compras_Vivace.csv"');
        res.send(csv);
    });
});

// Ruta para aprobar pagos múltiples agrupados en el admin con una sola factura
app.post('/admin/conciliar-pago-multiple', requerirAuthAdmin, (req, res) => {
    const { id_estudiante, comprobante, accion, numero_factura_emitida } = req.body;
    const nuevoEstatus = accion === 'aprobar' ? 'Pagado' : 'Rechazado';
    const nroFactura = numero_factura_emitida || 'S/N';

    if (!id_estudiante || !comprobante) {
        return res.redirect('/admin');
    }

    db.all(`SELECT * FROM cobros WHERE id_estudiante = ? AND comprobante = ? AND estatus = 'Revision'`, [id_estudiante, comprobante], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.redirect('/admin');
        }

        let completados = 0;
        rows.forEach(cobro => {
            const nuevoComp = `${comprobante} | Factura N°: ${nroFactura}`;
            db.run(`UPDATE cobros SET estatus = ?, comprobante = ? WHERE id = ?`, [nuevoEstatus, nuevoComp, cobro.id], () => {
                completados++;
                if (completados === rows.length) {
                    res.redirect('/admin');
                }
            });
        });
    });
});

app.post('/admin/conciliar-pago', requerirAuthAdmin, (req, res) => {
    const { id_cobro, accion, numero_factura_emitida } = req.body;
    const nuevoEstatus = accion === 'aprobar' ? 'Pagado' : 'Rechazado';
    const nroFactura = numero_factura_emitida || 'S/N';

    db.get(`SELECT * FROM cobros WHERE id = ?`, [id_cobro], (err, cobro) => {
        if (!err && cobro) {
            const nuevoComp = `${cobro.comprobante || 'Pago Móvil'} | Factura N°: ${nroFactura}`;
            db.run(`UPDATE cobros SET estatus = ?, comprobante = ? WHERE id = ?`, [nuevoEstatus, nuevoComp, id_cobro], () => {
                res.redirect('/admin');
            });
        } else {
            db.run(`UPDATE cobros SET estatus = ? WHERE id = ?`, [nuevoEstatus, id_cobro], () => {
                res.redirect('/admin');
            });
        }
    });
});

app.post('/admin/agregar-personal', requerirAuthAdmin, (req, res) => {
    const { nombre_empleado, cedula, cargos_multiples, cargo: cargoUnico, telefono, email, horas_mes, sueldo_base_ves, bono_alimentacion_usd, bono_transporte_usd, pago_movil_datos } = req.body;
    let cargoFinal = cargoUnico || '';
    if (cargos_multiples) {
        cargoFinal = Array.isArray(cargos_multiples) ? cargos_multiples.join(', ') : cargos_multiples;
    }

    db.run(`INSERT INTO personal (nombre_empleado, cedula, cargo, telefono, email, horas_mes, sueldo_base_ves, bono_alimentacion_usd, bono_transporte_usd, pago_movil_datos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [nombre_empleado, cedula, cargoFinal, telefono, email, horas_mes || 0, parseFloat(sueldo_base_ves) || 0, parseFloat(bono_alimentacion_usd) || 0, parseFloat(bono_transporte_usd) || 0, pago_movil_datos], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/registrar-pago-individual-docente', requerirAuthAdmin, (req, res) => {
    const { id_personal, tipo_pago, monto_ves, referencia, fecha_pago, observacion } = req.body;
    const monto_ves_num = parseFloat(monto_ves) || 0;
    const monto_usd = parseFloat((monto_ves_num / (req.tasaBCV || 813.74)).toFixed(2));
    const periodo = getMesAnioActual();

    db.run(`INSERT INTO pagos_personal (id_personal, tipo_pago, monto_ves, monto_usd, periodo_quincena, referencia, fecha_pago, observacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [id_personal, tipo_pago, monto_ves_num, monto_usd, periodo, referencia, fecha_pago, observacion], (err) => {
        if (err) return res.redirect('/admin');

        db.get(`SELECT * FROM personal WHERE id = ?`, [id_personal], (err, docente) => {
            if (err || !docente) return res.redirect('/admin');

            const proveedor = docente.nombre_empleado;
            const rif = docente.cedula ? `V-${docente.cedula}` : 'V-N/A';
            const conceptoEgreso = `Pago de ${tipo_pago.replace('_', ' ')} - ${docente.cargo}: ${docente.nombre_empleado} (${observacion || 'Nómina'})`;
            
            db.run(`INSERT INTO egresos (proveedor, rif, numero_factura, numero_control, concepto, monto_ves, fecha_egreso, monto_exento_ves, base_imponible_ves, monto_iva_ves, monto_usd, tiene_factura) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`, 
            [proveedor, rif, referencia, 'N/A', conceptoEgreso, monto_ves_num, fecha_pago || new Date().toISOString().substring(0, 10), monto_usd], () => {
                res.redirect('/admin');
            });
        });
    });
});

// Ruta administrativa para actualizar o subir la foto del estudiante
app.post('/admin/actualizar-foto-estudiante', requerirAuthAdmin, upload.single('foto_estudiante'), (req, res) => {
    const { id_estudiante } = req.body;
    
    if (!req.file) {
        return res.redirect('/admin');
    }

    const nuevaRutaFoto = '/uploads/' + req.file.filename;

    db.run(`UPDATE estudiantes SET foto = ? WHERE id = ?`, [nuevaRutaFoto, id_estudiante], (err) => {
        if (err) {
            console.error("Error al actualizar la foto:", err.message);
        }
        res.redirect('/admin');
    });
});
// Ruta para registrar pago/abono flexible desde el Admin con manejo de saldo a favor
app.post('/admin/registrar-pago-flexible', requerirAuthAdmin, (req, res) => {
    const { id_estudiante, monto_pagado_usd, concepto_id, referencia } = req.body;

    // 1. Consultar el cobro actual del estudiante
    db.get(`SELECT * FROM cobros WHERE id = ?`, [concepto_id], (err, cobro) => {
        if (err || !cobro) {
            return res.redirect('/admin');
        }

        const montoOficialUsd = Number(cobro.monto_usd);
        const pagoRealUsd = Number(monto_pagado_usd);

        // 2. Evaluar si hubo un excedente (abono para el mes siguiente)
        let excedenteUsd = 0;
        if (pagoRealUsd > montoOficialUsd) {
            excedenteUsd = pagoRealUsd - montoOficialUsd;
        }

        // 3. Marcar el cobro actual como 'Pagado'
        db.run(`UPDATE cobros SET estatus = 'Pagado', comprobante = ? WHERE id = ?`, [referencia, concepto_id], (err) => {
            if (err) console.error("Error al actualizar cobro:", err.message);

            // 4. Si hay excedente, puedes ingresarlo automáticamente como un saldo a favor o abono para la siguiente cuota pendiente
            if (excedenteUsd > 0) {
                // Buscar el siguiente mes o cuota pendiente del estudiante para aplicarle el abono
                db.get(`SELECT id, monto_usd FROM cobros WHERE id_estudiante = ? AND estatus = 'Pendiente' ORDER BY id ASC LIMIT 1`, [id_estudiante], (err, siguienteCobro) => {
                    if (siguienteCobro) {
                        // Opcional: Descontar el excedente en la próxima cuota o registrar una nota de abono
                        console.log(`Se aplicó un abono de $${excedenteUsd} para la siguiente cuota.`);
                    }
                });
            }

            res.redirect('/admin');
        });
    });
});
// Ruta administrativa para aprobar un pago o registrar un abono
app.post('/admin/aprobar-pago', requerirAuthAdmin, (req, res) => {
    const { cobro_id, monto_abonado_usd, referencia } = req.body; 
    // 'monto_abonado_usd' es lo que el representante realmente pagó y que tú ingresas manualmente.

    // 1. Buscar el cobro actual
    db.get(`SELECT * FROM cobros WHERE id = ?`, [cobro_id], (err, cobro) => {
        if (err || !cobro) return res.redirect('/admin');

        const montoOficial = Number(cobro.monto_usd); // El monto con descuento del mes
        const pagoReal = Number(monto_abonado_usd);

        // 2. Marcar el mes actual como PAGADO
        db.run(`UPDATE cobros SET estatus = 'Pagado', comprobante = ? WHERE id = ?`, [referencia, cobro_id], (err) => {
            
            // 3. Si el representante pagó de más (dejó un abono para el mes que viene)
            if (pagoReal > montoOficial) {
                const excedente = pagoReal - montoOficial;

                // Buscar el siguiente mes pendiente de ese estudiante
                db.get(`SELECT * FROM cobros WHERE id_estudiante = ? AND estatus = 'Pendiente' ORDER BY id ASC LIMIT 1`, [cobro.id_estudiante], (err, siguienteCobro) => {
                    if (siguienteCobro) {
                        const nuevoMontoSiguiente = Number(siguienteCobro.monto_usd) - excedente;
                        
                        // Actualizamos el siguiente mes restándole el abono que quedó a favor
                        db.run(`UPDATE cobros SET monto_usd = ? WHERE id = ?`, [nuevoMontoSiguiente > 0 ? nuevoMontoSiguiente : 0, siguienteCobro.id]);
                    }
                });
            }

            res.redirect('/admin');
        });
    });
});
// Ruta para generar el recibo de pago unificado (familiar)
app.get('/recibo/familia/:idParam', (req, res) => {
    const idParam = req.params.idParam;
    const tasaBCV = global.tasaBCV || 814.69;

    db.get(`SELECT * FROM pagos WHERE id = ? OR referencia = ? OR comprobante = ?`, [idParam, idParam, idParam], (err, pago) => {
        let queryEstudiante = `SELECT * FROM estudiantes WHERE id = ?`;
        let valEstudiante = [idParam];

        const callbackProcesar = (errPago, pagoEncontrado) => {
            let pagoFinal = pagoEncontrado;

            db.get(queryEstudiante, valEstudiante, (err, estudiantePrincipal) => {
                if (err || !estudiantePrincipal) {
                    if (pagoFinal) {
                        db.get(`SELECT * FROM estudiantes WHERE email_representante = ? OR nombre_estudiante = ?`, [pagoFinal.email_representante, pagoFinal.nombre_estudiante], (err, estAlt) => {
                            continuarConEstudiante(estAlt, pagoFinal);
                        });
                        return;
                    }
                    return res.status(404).send("Estudiante o recibo de pago no encontrado en el sistema.");
                }
                continuarConEstudiante(estudiantePrincipal, pagoFinal);
            });
        };

        if (!pago) {
            db.get(`SELECT * FROM cobros WHERE id_estudiante = ? ORDER BY id DESC LIMIT 1`, [idParam], (err, cobroEst) => {
                pago = cobroEst || { concepto: 'Mensualidad / Matrícula', monto_usd: 25, fecha: new Date().toISOString() };
                callbackProcesar(null, pago);
            });
        } else {
            callbackProcesar(null, pago);
        }

        function continuarConEstudiante(estudiantePrincipal, pagoObj) {
            const correoRep = estudiantePrincipal ? estudiantePrincipal.email_representante : (pagoObj.email_representante || '');

            db.all(`SELECT * FROM estudiantes WHERE email_representante = ?`, [correoRep], (err, hermanos) => {
                if (err || !hermanos || hermanos.length === 0) {
                    hermanos = estudiantePrincipal ? [estudiantePrincipal] : [];
                }

                res.render('recibo_familia', {
                    pago: pagoObj,
                    representante: {
                        nombre: estudiantePrincipal ? estudiantePrincipal.nombre_representante : (pagoObj.nombre_representante || "Representante"),
                        cedula: estudiantePrincipal ? estudiantePrincipal.cedula_representante : "V-00.000.000",
                        telefono: estudiantePrincipal ? estudiantePrincipal.telefono_representante : "0412-0000000",
                        direccion: estudiantePrincipal ? estudiantePrincipal.direccion : "Puerto La Cruz, Anzoátegui",
                        email: correoRep
                    },
                    hermanos,
                    tasaBCV: Number(pagoObj.tasa_cambio || pagoObj.tasa_historica || global.tasaBCV || 814.69)
                });
            });
        }
    });
});
app.post('/admin/editar-estudiante', requerirAuthAdmin, (req, res) => {
    console.log("¡Llegaron datos para actualizar estudiante:", req.body); // <--- Agrega esto temporalmente

    const { id_estudiante, nombre_estudiante, telefono_representante, email_representante, mensualidad_personalizada, exonerado } = req.body;

    db.run(
        `UPDATE estudiantes SET nombre_estudiante = ?, telefono_representante = ?, email_representante = ?, mensualidad_personalizada = ?, exonerado = ? WHERE id = ?`,
        [nombre_estudiante, telefono_representante, email_representante, mensualidad_personalizada, exonerado, id_estudiante],
        (err) => {
            if (err) console.error("Error al actualizar estudiante:", err.message);
            res.redirect('/admin');
        }
    );
});
// Ruta para registrar pagos flexibles, abonos y manejo de saldo a favor
app.post('/admin/registrar-pago-flexible', requerirAuthAdmin, (req, res) => {
    const { id_estudiante, monto_pagado_usd, concepto, referencia, fecha_pago } = req.body;
    const tasaActual = req.tasaBCV || 814.69;
    const montoUsdNum = Number(monto_pagado_usd) || 0;
    const montoVesNum = montoUsdNum * tasaActual;
    const fechaReal = fecha_pago || new Date().toISOString().substring(0, 10);

    db.get(`SELECT * FROM estudiantes WHERE id = ?`, [id_estudiante], (err, est) => {
        if (err || !est) return res.status(404).send("Estudiante no encontrado.");

        // Registramos el pago aprobado en la tabla de cobros o pagos con estatus Pagado
        db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus, comprobante) VALUES (?, ?, ?, ?, 'Pagado', ?)`,
        [est.id, concepto || 'Abono / Pago Flexible', montoUsdNum, getMesAnioActual(), referencia || 'Pago Directo'], function(err) {
            
            if (err) {
                console.error("Error al registrar pago flexible:", err);
                return res.status(500).send("Error al registrar el pago en la base de datos.");
            }

            console.log(`✔ Pago flexible registrado con éxito para ${est.name || est.nombre_estudiante}: $${montoUsdNum}`);
            res.redirect('/admin');
        });
    });
});
app.listen(PORT, () => {
    console.log(`Servidor en marcha en http://localhost:${PORT}`);
});