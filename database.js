const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Error al conectar con la base de datos SQLite:", err.message);
    } else {
        console.log("Conexión exitosa a la base de datos SQLite de Academia Vivace.");
    }
});

db.serialize(() => {
    // 1. Tabla Estudiantes
    db.run(`CREATE TABLE IF NOT EXISTS estudiantes (
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
        codigo_qr TEXT
    )`);

    // 2. Tabla Cobros Estudiantes
    db.run(`CREATE TABLE IF NOT EXISTS cobros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_estudiante INTEGER NOT NULL,
        concepto TEXT NOT NULL,
        monto_usd REAL NOT NULL,
        mes_anio TEXT NOT NULL,
        estatus TEXT DEFAULT 'Pendiente',
        comprobante TEXT,
        fecha_registro DATE DEFAULT CURRENT_DATE,
        FOREIGN KEY (id_estudiante) REFERENCES estudiantes(id)
    )`);

    // 3. Tabla Egresos / Libro SENIAT
    db.run(`CREATE TABLE IF NOT EXISTS egresos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proveedor TEXT NOT NULL,
        rif TEXT NOT NULL,
        numero_factura TEXT,
        numero_control TEXT,
        concepto TEXT NOT NULL,
        monto_ves REAL NOT NULL,
        monto_exento_ves REAL DEFAULT 0,
        base_imponible_ves REAL DEFAULT 0,
        monto_iva_ves REAL DEFAULT 0,
        monto_usd REAL DEFAULT 0,
        tiene_factura INTEGER DEFAULT 1,
        fecha_egreso DATE DEFAULT CURRENT_DATE
    )`);

    // 4. Tabla Personal / Profesores
    db.run(`CREATE TABLE IF NOT EXISTS personal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre_empleado TEXT NOT NULL,
        cedula TEXT,
        cargo TEXT NOT NULL,
        telefono TEXT,
        email TEXT UNIQUE,
        horas_mes INTEGER DEFAULT 0,
        sueldo_base_ves REAL NOT NULL,
        bono_alimentacion_usd REAL DEFAULT 0,
        bono_transporte_usd REAL DEFAULT 0,
        pago_movil_datos TEXT
    )`);

    // 5. Tabla Pagos y Adelantos de Nómina
    db.run(`CREATE TABLE IF NOT EXISTS pagos_personal (
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
    )`);
});

module.exports = db;