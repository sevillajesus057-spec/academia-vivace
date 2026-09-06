const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

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

let tasaBCVCached = 813.74;
let ultimaActualizacionTasa = 0;

async function obtenerTasaBCVOficial() {
    const ahora = Date.now();
    if (ahora - ultimaActualizacionTasa < 3600000 && tasaBCVCached) {
        return tasaBCVCached;
    }
    try {
        const response = await fetch('https://pydolarvenezuela-api.vercel.app/api/v1/dollar?monitor=bcv');
        const data = await response.json();
        if (data && data.price) {
            tasaBCVCached = Number(data.price);
            ultimaActualizacionTasa = ahora;
        }
    } catch (e) {}
    return tasaBCVCached;
}

app.use(async (req, res, next) => {
    req.tasaBCV = await obtenerTasaBCVOficial();
    res.locals.tasaBCV = req.tasaBCV;
    res.locals.boletinAutorizado = boletinAutorizado;
    next();
});

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

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

app.get('/', (req, res) => {
    res.render('index', { error: null });
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

app.post('/representante/reportar-pago', (req, res) => {
    const { id_cobro, comprobante, id_estudiante } = req.body;
    db.run(`UPDATE cobros SET estatus = 'Revision', comprobante = ? WHERE id = ?`, [comprobante, id_cobro], function(err) {
        res.redirect('/representante/portal/' + id_estudiante);
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
                                    const totalClases = registrosCat.length;
                                    const totalPresente = registrosCat.filter(a => a.estado === 'Presente').length;
                                    resumenAsistenciaPorCatedra[cat] = {
                                        presente: totalPresente,
                                        total: totalClases,
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

app.get('/representante/boletin/:id', (req, res) => {
    if (!boletinAutorizado) {
        return res.status(403).send("Los boletines se encuentran bloqueados temporalmente por la dirección.");
    }
    const idEstudiante = req.params.id;
    db.get(`SELECT * FROM estudiantes WHERE id = ?`, [idEstudiante], (err, estudiante) => {
        if (err || !estudiante) return res.status(404).send("Estudiante no encontrado.");

        const estKey = generarEstudianteKey(estudiante.nombre_estudiante, estudiante.email_representante);

        db.all(`SELECT * FROM calificaciones WHERE estudiante_key = ?`, [estKey], (err, calificaciones) => {
            if (err) calificaciones = [];
            db.all(`SELECT * FROM asistencia_clases WHERE estudiante_key = ?`, [estKey], (err, asistencias) => {
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

                res.render('boletin_pdf', {
                    estudiante: {
                        ...estudiante,
                        calificacionesAgrupadas,
                        asistenciaResumen
                    },
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

            res.render('carnet_publico', { 
                estudiante, 
                tasaBCV: req.tasaBCV,
                estatusCarnet 
            });
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
            const bonoAlimentacionUSD = parseFloat(miembro.bono_alimentacion_usd) || 0;
            const alimentacionBs = bonoAlimentacionUSD * tasaBCV;
            const bonoTransporteUSD = parseFloat(miembro.bono_transporte_usd) || 0;
            const transporteBs = bonoTransporteUSD * tasaBCV;
            const totalBrutoVES = sueldoBaseVES + alimentacionBs + transporteBs;

            const totalPagadoVES = pagos.reduce((acc, p) => acc + (p.monto_ves || 0), 0);
            const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoVES);

            res.render('admin_personal_portal', {
                miembro,
                tasaBCV,
                pagos,
                sueldoBaseVES,
                bonoAlimentacionUSD,
                alimentacionBs,
                bonoTransporteUSD,
                transporteBs,
                totalBrutoVES,
                totalPagadoVES,
                saldoPendienteVES
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
            const bonoAlimentacionUSD = parseFloat(docente.bono_alimentacion_usd) || 0;
            const alimentacionBs = bonoAlimentacionUSD * tasaBCV;
            const bonoTransporteUSD = parseFloat(docente.bono_transporte_usd) || 0;
            const transporteBs = bonoTransporteUSD * tasaBCV;
            const totalBrutoVES = sueldoBaseVES + alimentacionBs + transporteBs;

            const totalPagadoVES = pagos.reduce((acc, p) => acc + (p.monto_ves || 0), 0);
            const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoVES);

            db.all(`SELECT * FROM estudiantes ORDER BY nivel ASC, nombre_estudiante ASC`, [], (err, todosEstudiantes) => {
                if (err) todosEstudiantes = [];

                db.all(`SELECT * FROM asistencia_clases WHERE id_personal = ? ORDER BY fecha DESC`, [idDocente], (err, misAsistencias) => {
                    if (err) misAsistencias = [];
                    db.all(`SELECT * FROM calificaciones WHERE id_personal = ? ORDER BY id DESC`, [idDocente], (err, misCalificaciones) => {
                        if (err) misCalificaciones = [];
                        db.all(`SELECT * FROM solsitos ORDER BY id DESC`, [], (err, todosSolsitos) => {
                            if (err) todosSolsitos = [];

                            const estudiantesConPuntos = todosEstudiantes.map(est => {
                                const estKey = generarEstudianteKey(est.nombre_estudiante, est.email_representante);
                                const misSolsitos = todosSolsitos.filter(s => s.estudiante_key === estKey);
                                const totalSolsitos = misSolsitos.filter(s => (s.cantidad || 0) > 0).reduce((acc, s) => acc + s.cantidad, 0);
                                const totalSilencios = misSolsitos.filter(s => (s.cantidad || 0) < 0).reduce((acc, s) => acc + Math.abs(s.cantidad), 0);
                                return {
                                    ...est,
                                    estKey,
                                    totalSolsitos,
                                    totalSilencios,
                                    historialSolsitos: misSolsitos
                                };
                            });

                            res.render('docente_portal', { 
                                docente, 
                                tasaBCV, 
                                pagos, 
                                estudiantes: estudiantesConPuntos,
                                misAsistencias,
                                misCalificaciones,
                                sueldoBaseVES,
                                bonoAlimentacionUSD,
                                alimentacionBs,
                                bonoTransporteUSD,
                                transporteBs,
                                totalBrutoVES, 
                                totalPagadoVES, 
                                saldoPendienteVES 
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
    const motivoFinal = motivo || (tipo_punto === 'negativo' ? 'Silencio de negra (Demérito)' : 'Solsito ganado');

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

app.get('/admin', requerirAuthAdmin, (req, res) => {
    try {
        const tasaBCV = req.tasaBCV || 813.74;
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
                            db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 10.00, ?, 'Pendiente')`, [est.id, `Mensualidad ${nombreMesActual}`, mesAnioActual]);
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

                    const totalEgresosUSDCalc = egresos.reduce((acc, e) => acc + (e.monto_usd || 0), 0);
                    const saldoCajaUSD = Math.max(0, totalIngresosUSD - totalEgresosUSDCalc);

                    const cobrosPorRevisar = cobros.filter(c => c.estatus === 'Revision').map(c => {
                        const est = estudiantes.find(e => e.id === c.id_estudiante);
                        return { 
                            ...c, 
                            nombre_estudiante: est ? est.nombre_estudiante : 'Desconocido', 
                            nombre_representante: est ? est.nombre_representante : 'N/A',
                            telefono_representante: est ? est.telefono_representante : ''
                        };
                    });

                    db.all(`SELECT * FROM personal`, [], (err, personalList) => {
                        if (err || !personalList) personalList = [];
                        db.all(`SELECT * FROM pagos_personal ORDER BY fecha_pago DESC`, [], (err, pagosList) => {
                            if (err || !pagosList) pagosList = [];
                            
                            db.all(`SELECT a.*, COALESCE(e.nombre_estudiante, 'Estudiante No Encontrado') AS nombre_estudiante FROM asistencia_clases a LEFT JOIN estudiantes e ON a.estudiante_key = (LOWER(TRIM(e.nombre_estudiante)) || '__' || LOWER(TRIM(e.email_representante))) ORDER BY a.fecha DESC`, [], (err, todasAsistencias) => {
                                if (err) todasAsistencias = [];
                                db.all(`SELECT c.*, COALESCE(e.nombre_estudiante, 'Estudiante No Encontrado') AS nombre_estudiante FROM calificaciones c LEFT JOIN estudiantes e ON c.estudiante_key = (LOWER(TRIM(e.nombre_estudiante)) || '__' || LOWER(TRIM(e.email_representante))) ORDER BY c.id DESC`, [], (err, todasCalificaciones) => {
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

                                        const sueldoCompleto = sueldoPagado >= (sueldoBase - 1);
                                        const alimentacionCompleta = alimentacionPagada >= (alimentacionBs - 1);
                                        const transporteCompleto = transportePagado >= (transporteBs - 1);

                                        const totalPagadoMes = sueldoPagado + alimentacionPagada + transportePagado;
                                        totalNominaPagadaVES += totalPagadoMes;

                                        const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoMes);
                                        totalNominaRequeridaVES += saldoPendienteVES;

                                        return {
                                            ...p,
                                            totalBrutoVES,
                                            saldoPendienteVES,
                                            sueldoCompleto,
                                            alimentacionCompleta,
                                            transporteCompleto,
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
    const { nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto, direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumentos_multiples, instrumento: instrumentoUnico, nivel, observaciones_medicas, exonerado } = req.body;
    
    // Unir los instrumentos seleccionados si vienen varios por checkbox
    let instrumentoFinal = instrumentoUnico || '';
    if (instrumentos_multiples) {
        if (Array.isArray(instrumentos_multiples)) {
            instrumentoFinal = instrumentos_multiples.join(', ');
        } else {
            instrumentoFinal = instrumentos_multiples;
        }
    }

    const codigo_qr = 'VIVACE-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const mesAnio = getMesAnioActual();
    const nombreMes = getNombreMesActual();
    const esExonerado = exonerado ? 1 : 0;

    db.run(`INSERT INTO estudiantes (nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto, direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumento, nivel, observaciones_medicas, codigo_qr, exonerado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto || '', direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumentoFinal, nivel, observaciones_medicas, codigo_qr, esExonerado], function(err) {
        if (err) {
            console.error("Error al insertar estudiante:", err.message);
            return res.redirect('/admin');
        }
        if (esExonerado) return res.redirect('/admin');
        
        const idEst = this.lastID;
        db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, 'Inscripción Matrícula Inicial', 5.00, ?, 'Pendiente')`, [idEst, mesAnio], () => {
            db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 10.00, ?, 'Pendiente')`, [idEst, `Mensualidad ${nombreMes}`, mesAnio], () => {
                res.redirect('/admin');
            });
        });
    });
});

app.post('/admin/editar-estudiante', requerirAuthAdmin, (req, res) => {
    const { id_estudiante, nombre_estudiante, telefono_representante, email_representante, instrumento, nivel, exonerado } = req.body;
    const esExonerado = exonerado ? 1 : 0;

    db.run(`UPDATE estudiantes SET nombre_estudiante = ?, telefono_representante = ?, email_representante = ?, instrumento = ?, nivel = ?, exonerado = ? WHERE id = ?`, 
    [nombre_estudiante, telefono_representante, email_representante, instrumento, nivel, esExonerado, id_estudiante], () => {
        res.redirect('/admin');
    });
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
    [montoUsdNum, comprobante, id_cobro], (err) => {
        res.redirect('/admin');
    });
});

app.post('/admin/agregar-egreso', requerirAuthAdmin, (req, res) => {
    const { proveedor, rif, numero_factura, numero_control, concepto, monto_ves, fecha_egreso, monto_usd, tiene_factura } = req.body;
    const monto_ves_num = parseFloat(monto_ves) || 0;
    const tieneFacturaBool = parseInt(tiene_factura) === 1;
    const fechaCompra = fecha_egreso || new Date().toISOString().substring(0, 10);
    
    let baseImponible = 0;
    let montoIva = 0;
    let montoExento = 0;

    if (tieneFacturaBool) {
        baseImponible = monto_ves_num / 1.16;
        montoIva = monto_ves_num - baseImponible;
        montoExento = 0;
    } else {
        montoExento = monto_ves_num;
        baseImponible = 0;
        montoIva = 0;
    }

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
        if (Array.isArray(cargos_multiples)) {
            cargoFinal = cargos_multiples.join(', ');
        } else {
            cargoFinal = cargos_multiples;
        }
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
            const numFactura = referencia;
            const conceptoEgreso = `Pago de ${tipo_pago.replace('_', ' ')} - ${docente.cargo}: ${docente.nombre_empleado} (${observacion || 'Nómina'})`;
            
            db.run(`INSERT INTO egresos (proveedor, rif, numero_factura, numero_control, concepto, monto_ves, fecha_egreso, monto_exento_ves, base_imponible_ves, monto_iva_ves, monto_usd, tiene_factura) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`, 
            [proveedor, rif, numFactura, 'N/A', conceptoEgreso, monto_ves_num, fecha_pago || new Date().toISOString().substring(0, 10), monto_usd], () => {
                res.redirect('/admin');
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor en marcha en http://localhost:${PORT}`);
});