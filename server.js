const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');

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

function requerirAuthAdmin(req, res, next) {
    if (req.session && req.session.esAdmin) return next();
    res.redirect('/admin/login');
}

app.use((req, res, next) => {
    req.tasaBCV = 813.74; 
    res.locals.tasaBCV = req.tasaBCV;
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

app.get('/', (req, res) => {
    res.render('index', { error: null });
});

app.post('/representante/login', (req, res) => {
    const { busqueda } = req.body;
    const busquedaClean = (busqueda || '').trim();
    if (!busquedaClean) return res.render('index', { error: 'Por favor ingrese una cédula o correo válido.' });

    db.all(`SELECT * FROM estudiantes WHERE email_representante = ? OR cedula_representante = ?`, [busquedaClean, busquedaClean], (err, estudiantes) => {
        if (err || !estudiantes || estudiantes.length === 0) {
            return res.render('index', { error: 'No se encontraron estudiantes asociados.' });
        }
        const ids = estudiantes.map(e => e.id);
        const placeholders = ids.map(() => '?').join(',');

        db.all(`SELECT * FROM cobros WHERE id_estudiante IN (${placeholders}) ORDER BY id DESC`, ids, (err, cobros) => {
            if (err) cobros = [];
            const estudiantesConCobros = estudiantes.map(est => ({
                ...est,
                cobrosHistorial: cobros.filter(c => c.id_estudiante === est.id)
            }));
            res.render('representante_portal', { estudiantes: estudiantesConCobros, tasaBCV: req.tasaBCV });
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
                const estudiantesProcesados = listaEstudiantes.map(e => ({
                    ...e,
                    cobrosHistorial: cobros.filter(c => c.id_estudiante === e.id)
                }));
                res.render('representante_portal', { estudiantes: estudiantesProcesados, tasaBCV: req.tasaBCV });
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
            const estatusCarnet = cobrosPendientes.length > 3 ? 'INACTIVO (MOROSO)' : 'ACTIVO';

            res.render('carnet_publico', { 
                estudiante, 
                tasaBCV: req.tasaBCV,
                estatusCarnet 
            });
        });
    });
});

// Portal Docentes
app.get('/docente/login', (req, res) => {
    res.render('docente_login', { error: null });
});

app.post('/docente/login', (req, res) => {
    db.get(`SELECT * FROM personal WHERE email = ?`, [(req.body.email || '').trim()], (err, docente) => {
        if (err || !docente) return res.render('docente_login', { error: 'Correo no registrado en la nómina.' });
        res.redirect('/docente/portal/' + docente.id);
    });
});

app.get('/docente/portal/:id', (req, res) => {
    const idDocente = req.params.id;
    const tasaBCV = req.tasaBCV;

    db.get(`SELECT * FROM personal WHERE id = ?`, [idDocente], (err, docente) => {
        if (err || !docente) return res.status(404).send("Docente no encontrado.");

        db.all(`SELECT * FROM pagos_personal WHERE id_personal = ? ORDER BY fecha_pago DESC`, [idDocente], (err, pagos) => {
            if (err) pagos = [];
            const sueldoBase = parseFloat(docente.sueldo_base_ves) || 0;
            const alimentacionBs = (parseFloat(docente.bono_alimentacion_usd) || 0) * tasaBCV;
            const transporteBs = (parseFloat(docente.bono_transporte_usd) || 0) * tasaBCV;
            const totalBrutoVES = sueldoBase + alimentacionBs + transporteBs;

            const totalPagadoVES = pagos.reduce((acc, p) => acc + (p.monto_ves || 0), 0);
            const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoVES);

            res.render('docente_portal', { docente, tasaBCV, pagos, totalBrutoVES, totalPagadoVES, saldoPendienteVES });
        });
    });
});

// Admin Auth
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

// Panel Admin Principal
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
                    const tieneCobroMes = cobros.some(c => c.id_estudiante === est.id && c.mes_anio === mesAnioActual && c.concepto && c.concepto.includes('Mensualidad'));
                    if (!tieneCobroMes) {
                        db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 10.00, ?, 'Pendiente')`, [est.id, `Mensualidad ${nombreMesActual}`, mesAnioActual]);
                    }
                });

                const estudiantesProcesados = estudiantes.map(est => {
                    const misCobros = cobros.filter(c => c.id_estudiante === est.id);
                    const pagadoUSD = misCobros.filter(c => c.estatus === 'Pagado').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                    const pendienteUSD = misCobros.filter(c => c.estatus === 'Pendiente' || c.estatus === 'Revision').reduce((acc, c) => acc + (c.monto_usd || 0), 0);
                    return { ...est, estaAlDia: pendienteUSD === 0, deudaUSD: pendienteUSD, pagadoUSD, cobrosHistorial: misCobros };
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

                    // --- CÁLCULO DINÁMICO DE CAJA SEGÚN INGRESOS REALES Y EGRESOS ---
                    const totalEgresosUSDCalc = egresos.reduce((acc, e) => acc + (e.monto_usd || 0), 0);
                    const saldoCajaUSD = Math.max(0, totalIngresosUSD - totalEgresosUSDCalc);
                    // -------------------------------------------------------------

                    const cobrosPorRevisar = cobros.filter(c => c.estatus === 'Revision').map(c => {
                        const est = estudiantes.find(e => e.id === c.id_estudiante);
                        return { ...c, nombre_estudiante: est ? est.nombre_estudiante : 'Desconocido', nombre_representante: est ? est.nombre_representante : 'N/A' };
                    });

                    db.all(`SELECT * FROM personal`, [], (err, personalList) => {
                        if (err || !personalList) personalList = [];
                        db.all(`SELECT * FROM pagos_personal ORDER BY fecha_pago DESC`, [], (err, pagosList) => {
                            if (err || !pagosList) pagosList = [];
                            let totalNominaRequeridaVES = 0;

                            const personalProcesado = personalList.map(p => {
                                const sueldoBase = parseFloat(p.sueldo_base_ves) || 0;
                                const alimentacionBs = (parseFloat(p.bono_alimentacion_usd) || 0) * tasaBCV;
                                const transporteBs = (parseFloat(p.bono_transporte_usd) || 0) * tasaBCV;
                                const totalBrutoVES = sueldoBase + alimentacionBs + transporteBs;

                                const misPagosMes = pagosList.filter(pg => pg.id_personal === p.id && pg.periodo_quincena === mesAnioActual);

                                const sueldoPagado = misPagosMes.filter(pg => pg.tipo_pago === 'SUELDO_BASE').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);
                                const alimentacionPagada = misPagosMes.filter(pg => pg.tipo_pago === 'CESTA_TICKET').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);
                                const transportePagado = misPagosMes.filter(pg => pg.tipo_pago === 'TRANSPORTE').reduce((acc, pg) => acc + (pg.monto_ves || 0), 0);

                                const sueldoCompleto = sueldoPagado >= sueldoBase;
                                const alimentacionCompleta = alimentacionPagada >= alimentacionBs;
                                const transporteCompleto = transportePagado >= transporteBs;

                                const totalPagadoMes = sueldoPagado + alimentacionPagada + transportePagado;
                                const saldoPendienteVES = Math.max(0, totalBrutoVES - totalPagadoMes);
                                totalNominaRequeridaVES += saldoPendienteVES;

                                return {
                                    ...p,
                                    totalBrutoVES,
                                    sueldoCompleto,
                                    alimentacionCompleta,
                                    transporteCompleto,
                                    saldoPendienteVES,
                                    historialPagos: misPagosMes
                                };
                            });

                            const totalNominaRequeridaUSD = totalNominaRequeridaVES / tasaBCV;
                            const cajaCubreNomina = saldoCajaUSD >= totalNominaRequeridaUSD;

                            res.render('admin', {
                                tasaBCV,
                                estudiantes: estudiantesProcesados,
                                egresos,
                                totalIngresosVES: totalIngresosVES || 0,
                                totalIngresosUSD: totalIngresosUSD || 0,
                                totalEgresosVES: totalEgresosVES || 0,
                                totalEgresosUSD: totalEgresosUSD || 0,
                                totalIvaDebitoVES,
                                totalIvaCreditoVES,
                                cobrosPorRevisar,
                                personal: personalProcesado,
                                totalNominaRequeridaVES,
                                totalNominaRequeridaUSD,
                                saldoCajaUSD,
                                cajaCubreNomina,
                                nombreMesActual
                            });
                        });
                    });
                });
            });
        });
    } catch (e) {
        res.status(500).send("Error interno en panel admin.");
    }
});

app.post('/admin/agregar-estudiante', requerirAuthAdmin, (req, res) => {
    const { nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto, direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumento, nivel, observaciones_medicas } = req.body;
    const codigo_qr = 'VIVACE-' + Date.now();
    const mesAnio = getMesAnioActual();
    const nombreMes = getNombreMesActual();

    db.run(`INSERT INTO estudiantes (nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto, direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumento, nivel, observaciones_medicas, codigo_qr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [nombre_estudiante, cedula_estudiante, fecha_nacimiento, edad, tipo_sangre, foto, direccion, nombre_representante, cedula_representante, telefono_representante, parentesco, email_representante, instrumento, nivel, observaciones_medicas, codigo_qr], function(err) {
        if (err) return res.redirect('/admin');
        const idEst = this.lastID;
        db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, 'Inscripción Matrícula Inicial', 5.00, ?, 'Pendiente')`, [idEst, mesAnio], () => {
            db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, 10.00, ?, 'Pendiente')`, [idEst, `Mensualidad ${nombreMes}`, mesAnio], () => {
                res.redirect('/admin');
            });
        });
    });
});

app.post('/admin/agregar-cobro-estudiante', requerirAuthAdmin, (req, res) => {
    db.run(`INSERT INTO cobros (id_estudiante, concepto, monto_usd, mes_anio, estatus) VALUES (?, ?, ?, ?, 'Pendiente')`, [req.body.id_estudiante, req.body.concepto, parseFloat(req.body.monto_usd) || 0, getMesAnioActual()], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/agregar-egreso', requerirAuthAdmin, (req, res) => {
    const { proveedor, rif, numero_factura, numero_control, concepto, monto_ves, monto_exento_ves, base_imponible_ves, monto_usd, tiene_factura } = req.body;
    const monto_ves_num = parseFloat(monto_ves) || 0;
    const tieneFacturaBool = parseInt(tiene_factura) === 1;
    let baseImponible = parseFloat(base_imponible_ves) || 0;
    let montoIva = 0;

    if (tieneFacturaBool) {
        if (!baseImponible) baseImponible = monto_ves_num / 1.16;
        montoIva = monto_ves_num - baseImponible;
    }

    db.run(`INSERT INTO egresos (proveedor, rif, numero_factura, numero_control, concepto, monto_ves, monto_exento_ves, base_imponible_ves, monto_iva_ves, monto_usd, tiene_factura) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [proveedor, rif, numero_factura, numero_control, concepto, monto_ves_num, parseFloat(monto_exento_ves) || 0, baseImponible, montoIva, parseFloat(monto_usd) || 0, tieneFacturaBool ? 1 : 0], () => {
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
    db.run(`UPDATE cobros SET estatus = ? WHERE id = ?`, [req.body.accion === 'aprobar' ? 'Pagado' : 'Rechazado', req.body.id_cobro], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/agregar-personal', requerirAuthAdmin, (req, res) => {
    const { nombre_empleado, cedula, cargo, telefono, email, horas_mes, sueldo_base_ves, bono_alimentacion_usd, bono_transporte_usd, pago_movil_datos } = req.body;
    db.run(`INSERT INTO personal (nombre_empleado, cedula, cargo, telefono, email, horas_mes, sueldo_base_ves, bono_alimentacion_usd, bono_transporte_usd, pago_movil_datos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [nombre_empleado, cedula, cargo, telefono, email, horas_mes || 0, parseFloat(sueldo_base_ves) || 0, parseFloat(bono_alimentacion_usd) || 0, parseFloat(bono_transporte_usd) || 0, pago_movil_datos], () => {
        res.redirect('/admin');
    });
});

app.post('/admin/registrar-pago-individual-docente', requerirAuthAdmin, (req, res) => {
    const { id_personal, tipo_pago, monto_ves, referencia, fecha_pago, observacion } = req.body;
    const monto_ves_num = parseFloat(monto_ves) || 0;
    const monto_usd = parseFloat((monto_ves_num / (req.tasaBCV || 813.74)).toFixed(2));
    const periodo = getMesAnioActual();

    db.run(`INSERT INTO pagos_personal (id_personal, tipo_pago, monto_ves, monto_usd, periodo_quincena, referencia, fecha_pago, observacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [id_personal, tipo_pago, monto_ves_num, monto_usd, periodo, referencia, fecha_pago, observacion], () => {
        res.redirect('/admin');
    });
});

app.listen(PORT, () => {
    console.log(`Servidor en marcha en http://localhost:${PORT}`);
});