const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Conexión a la base de datos local de SQLite
const dbFile = path.join(__dirname, 'academia_vivace.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error al conectar con SQLite:", err.message);
    } else {
        console.log("Conexión exitosa a la base de datos local SQLite de Academia Vivace.");
    }
});

// Inicializar tablas automáticamente
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS estudiantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre_estudiante TEXT NOT NULL,
            cedula_estudiante TEXT,
            fecha_nacimiento TEXT,
            edad INTEGER,
            tipo_sangre TEXT,
            direccion TEXT,
            foto TEXT,
            nombre_representante TEXT NOT NULL,
            cedula_representante TEXT,
            telefono_representante TEXT,
            parentesco TEXT,
            email_representante TEXT NOT NULL,
            instrumento TEXT NOT NULL,
            nivel TEXT NOT NULL,
            observaciones_medicas TEXT,
            codigo_qr TEXT,
            exonerado INTEGER DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS cobros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_estudiante INTEGER NOT NULL,
            concepto TEXT NOT NULL,
            monto_usd REAL NOT NULL,
            mes_anio TEXT NOT NULL,
            estatus TEXT DEFAULT 'Pendiente',
            comprobante TEXT,
            fecha_registro DATE DEFAULT (date('now')),
            FOREIGN KEY (id_estudiante) REFERENCES estudiantes(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS egresos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proveedor TEXT,
            rif TEXT,
            numero_factura TEXT,
            numero_control TEXT,
            concepto TEXT NOT NULL,
            monto_ves REAL NOT NULL,
            monto_exento_ves REAL DEFAULT 0,
            base_imponible_ves REAL DEFAULT 0,
            monto_iva_ves REAL DEFAULT 0,
            monto_usd REAL DEFAULT 0,
            tiene_factura INTEGER DEFAULT 1,
            fecha_egreso DATE DEFAULT (date('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS personal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre_empleado TEXT,
            cedula TEXT,
            cargo TEXT NOT NULL,
            telefono TEXT,
            email TEXT UNIQUE,
            horas_mes INTEGER DEFAULT 0,
            sueldo_base_ves REAL NOT NULL,
            bono_alimentacion_usd REAL DEFAULT 0,
            bono_transporte_usd REAL DEFAULT 0,
            pago_movil_datos TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS pagos_personal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            id_personal INTEGER NOT NULL,
            tipo_pago TEXT NOT NULL,
            monto_ves REAL NOT NULL,
            monto_usd REAL NOT NULL,
            periodo_quincena TEXT NOT NULL,
            referencia TEXT NOT NULL,
            fecha_pago DATE NOT NULL,
            observacion TEXT,
            FOREIGN KEY (id_personal) REFERENCES personal(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS asistencia_clases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estudiante_key TEXT NOT NULL,
            id_personal INTEGER NOT NULL,
            catedra TEXT NOT NULL,
            fecha TEXT NOT NULL,
            estado TEXT NOT NULL,
            FOREIGN KEY (id_personal) REFERENCES personal(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS calificaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estudiante_key TEXT NOT NULL,
            id_personal INTEGER NOT NULL,
            periodo TEXT NOT NULL,
            catedra TEXT NOT NULL,
            objetivo TEXT NOT NULL,
            indicador TEXT NOT NULL,
            calificacion TEXT NOT NULL,
            observacion TEXT,
            FOREIGN KEY (id_personal) REFERENCES personal(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS solsitos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estudiante_key TEXT NOT NULL,
            id_personal INTEGER NOT NULL,
            cantidad INTEGER NOT NULL,
            motivo TEXT,
            periodo TEXT NOT NULL,
            fecha_registro DATE DEFAULT (date('now')),
            FOREIGN KEY (id_personal) REFERENCES personal(id)
        )
    `);

    console.log("Tablas locales de SQLite verificadas y listas.");
});

module.exports = db;