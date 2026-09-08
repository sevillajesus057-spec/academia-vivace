const { createClient } = require('@libsql/client');

// Conexión oficial a tu base de datos en la nube Turso
const client = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://academia-vivace-db-jesus057.aws-us-east-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODg3NDAyMDAsImlkIjoiMDFhMDc5MzYtZjYwMS03ZTA5LWI3N2EtNWZlYzNkYTZiNTNhIiwia2lkIjoiT1M1LUtkbFIwYUlINHBLSHk1ajNpWjFub0p3SFM5dko3Q0VaMTExSlE0QSIsInJpZCI6ImIzYmI0OTZiLThiNGItNGViNy1hNGZmLTNkODM4M2Q1Y2FhMyJ9.kVNpiAWlcEPIzB7BUwDHm7cWEb_sn8AvLZm9zQIRePqeOh1oWJpQ7jWCuxNehNQx9CRXeDm1vMuplvi8s0e0Bw"
});

// Adaptador compatible con los callbacks de sqlite3 que usa server.js
const db = {
    all: async (sql, params = [], callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const res = await client.execute({ sql, args: params });
            if (callback) callback(null, res.rows);
        } catch (err) {
            if (callback) callback(err, null);
        }
    },
    get: async (sql, params = [], callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const res = await client.execute({ sql, args: params });
            if (callback) callback(null, res.rows[0] || null);
        } catch (err) {
            if (callback) callback(err, null);
        }
    },
    run: async (sql, params = [], callback) => {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const res = await client.execute({ sql, args: params });
            const context = { 
                lastID: Number(res.lastInsertRowid || 0), 
                changes: res.rowsAffected 
            };
            if (callback) {
                callback.call(context, null);
            }
        } catch (err) {
            if (callback) {
                callback.call({}, err);
            }
        }
    }
};

// Inicializar tablas automáticamente en la nube
async function inicializarTablas() {
    try {
        // Tabla de configuración para la Tasa BCV oficial
        await client.execute(`
            CREATE TABLE IF NOT EXISTS configuracion (
                clave TEXT PRIMARY KEY,
                valor TEXT
            )
        `);

        // Insertar valor inicial de respaldo si no existe
        await client.execute(`
            INSERT OR IGNORE INTO configuracion (clave, valor) VALUES ('tasa_bcv', '814.69')
        `);

        await client.execute(`
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

        await client.execute(`
            CREATE TABLE IF NOT EXISTS cobros (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_estudiante INTEGER NOT NULL,
                concepto TEXT NOT NULL,
                monto_usd REAL NOT NULL,
                mes_anio TEXT NOT NULL,
                estatus TEXT DEFAULT 'Pendiente',
                comprobante TEXT,
                fecha_registro TEXT DEFAULT (date('now')),
                FOREIGN KEY (id_estudiante) REFERENCES estudiantes(id) ON DELETE CASCADE
            )
        `);

        await client.execute(`
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
                fecha_egreso TEXT DEFAULT (date('now'))
            )
        `);

        await client.execute(`
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

        await client.execute(`
            CREATE TABLE IF NOT EXISTS pagos_personal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                id_personal INTEGER NOT NULL,
                tipo_pago TEXT NOT NULL,
                monto_ves REAL NOT NULL,
                monto_usd REAL NOT NULL,
                periodo_quincena TEXT NOT NULL,
                referencia TEXT NOT NULL,
                fecha_pago TEXT NOT NULL,
                observacion TEXT,
                FOREIGN KEY (id_personal) REFERENCES personal(id)
            )
        `);

        await client.execute(`
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

        await client.execute(`
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

        await client.execute(`
            CREATE TABLE IF NOT EXISTS solsitos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                estudiante_key TEXT NOT NULL,
                id_personal INTEGER NOT NULL,
                cantidad INTEGER NOT NULL,
                motivo TEXT,
                periodo TEXT NOT NULL,
                fecha_registro TEXT DEFAULT (date('now')),
                FOREIGN KEY (id_personal) REFERENCES personal(id)
            )
        `);

        console.log("¡Conexión y tablas sincronizadas en Turso con éxito!");
    } catch (err) {
        console.error("Error al inicializar las tablas en Turso:", err.message);
    }
}

inicializarTablas();

module.exports = db;