const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de la base de datos PostgreSQL (Supabase)
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
});

const MAX_INTENTOS = 5;

// ============================================
// RUTA DE PRUEBA
// ============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'SIGME Backend funcionando', timestamp: new Date() });
});

// ============================================
// AUTENTICACIÓN - LOGIN
// ============================================
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales incorrectas' });
        }
        
        const usuario = result.rows[0];
        
        if (usuario.bloqueado) {
            return res.status(423).json({ message: 'Usuario bloqueado. Contacte al administrador.' });
        }
        
        const passwordValida = await bcrypt.compare(password, usuario.password_hash);
        
        if (!passwordValida) {
            const nuevosIntentos = usuario.intentos_fallidos + 1;
            await pool.query('UPDATE usuarios SET intentos_fallidos = $1 WHERE id = $2', [nuevosIntentos, usuario.id]);
            
            if (nuevosIntentos >= MAX_INTENTOS) {
                await pool.query('UPDATE usuarios SET bloqueado = true WHERE id = $1', [usuario.id]);
                return res.status(423).json({ message: 'Demasiados intentos. Usuario bloqueado.' });
            }
            return res.status(401).json({ message: 'Credenciales incorrectas' });
        }
        
        await pool.query('UPDATE usuarios SET intentos_fallidos = 0, ultimo_login = NOW() WHERE id = $1', [usuario.id]);
        
        const token = jwt.sign(
            { id: usuario.id, username: usuario.username, perfil: usuario.perfil },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: usuario.id,
                username: usuario.username,
                nombre_completo: usuario.nombre_completo,
                perfil: usuario.perfil
            }
        });
        
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// ============================================
// ESTABLECIMIENTOS (Autocompletado)
// ============================================
app.get('/api/establecimientos/buscar', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) {
        return res.json([]);
    }
    
    try {
        const result = await pool.query(
            'SELECT id, nombre FROM establecimientos WHERE nombre ILIKE $1 AND activo = true LIMIT 10',
            [`%${q}%`]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al buscar establecimientos' });
    }
});

app.get('/api/establecimientos', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nombre FROM establecimientos WHERE activo = true ORDER BY nombre');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener establecimientos' });
    }
});

// ============================================
// USUARIOS (ITOs)
// ============================================
app.get('/api/usuarios/itos', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, username, nombre_completo, email FROM usuarios WHERE perfil = 'ito' AND activo = true ORDER BY nombre_completo"
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener ITOs' });
    }
});

// ============================================
// TIPOS DE SERVICIO
// ============================================
app.get('/api/ot/tipos-servicio', (req, res) => {
    const tipos = [
        'Mantenimiento',
        'Techumbre/Cubierta',
        'Áreas Verdes',
        'Mitigación Palomas',
        'Inspección Sello Verde',
        'Reparación Sello Verde',
        'Pizarras'
    ];
    res.json(tipos);
});

// ============================================
// FUNCIÓN PARA GENERAR NÚMERO DE OT
// ============================================
async function generarNumeroOT(tipoServicio) {
    const prefijos = {
        'Mantenimiento': 'OT',
        'Techumbre/Cubierta': 'CB',
        'Áreas Verdes': 'AV',
        'Mitigación Palomas': 'MP',
        'Inspección Sello Verde': 'IG',
        'Reparación Sello Verde': 'RG',
        'Pizarras': 'PZ'
    };
    
    const prefijo = prefijos[tipoServicio] || 'OT';
    
    const result = await pool.query(
        'SELECT numero_ot FROM intervenciones WHERE numero_ot LIKE $1 ORDER BY numero_ot DESC LIMIT 1',
        [`${prefijo}.%`]
    );
    
    let ultimoNumero = 0;
    if (result.rows.length > 0) {
        const match = result.rows[0].numero_ot.match(/\d+$/);
        if (match) {
            ultimoNumero = parseInt(match[0]);
        }
    }
    
    const nuevoNumero = ultimoNumero + 1;
    return `${prefijo}.${nuevoNumero.toString().padStart(4, '0')}`;
}

// ============================================
// ASIGNAR ORDEN DE TRABAJO
// ============================================
app.post('/api/ot/asignar', async (req, res) => {
    const { tipo_servicio, establecimiento_id, ito_id, fecha_plazo, observaciones, antecedentes } = req.body;
    
    try {
        const numeroOT = await generarNumeroOT(tipo_servicio);
        
        const result = await pool.query(
            `INSERT INTO intervenciones 
             (numero_ot, tipo_servicio, establecimiento_id, ito_id, fecha_plazo, observaciones, estado) 
             VALUES ($1, $2, $3, $4, $5, $6, 'Asignada') 
             RETURNING *`,
            [numeroOT, tipo_servicio, establecimiento_id, ito_id, fecha_plazo, observaciones]
        );
        
        const nuevaOT = result.rows[0];
        
        if (antecedentes && antecedentes.length > 0) {
            for (const ant of antecedentes) {
                await pool.query(
                    `INSERT INTO antecedentes 
                     (intervencion_id, numero_ticket, descripcion, archivo_url, archivo_nombre_original, archivo_tipo) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [nuevaOT.id, ant.numero_ticket, ant.descripcion, ant.archivo_url, ant.archivo_nombre, ant.archivo_tipo]
                );
            }
        }
        
        res.status(201).json({ success: true, message: 'OT asignada correctamente', ot: nuevaOT });
        
    } catch (error) {
        console.error('Error al asignar OT:', error);
        res.status(500).json({ message: 'Error al asignar la orden de trabajo' });
    }
});

// ============================================
// LEVANTAMIENTO DE OT
// ============================================
app.get('/api/levantamiento/ot/:ito_id', async (req, res) => {
    const { ito_id } = req.params;
    const { estado, establecimiento, numero_ot } = req.query;
    
    try {
        let query = `
            SELECT i.*, e.nombre as establecimiento_nombre,
                   TO_CHAR(i.fecha_plazo, 'YYYY-MM-DD') as sla
            FROM intervenciones i
            JOIN establecimientos e ON i.establecimiento_id = e.id
            WHERE i.ito_id = $1
        `;
        let params = [ito_id];
        let paramIndex = 2;
        
        if (estado && estado !== 'todos') {
            query += ` AND i.estado = $${paramIndex}`;
            params.push(estado);
            paramIndex++;
        }
        
        if (establecimiento) {
            query += ` AND e.nombre ILIKE $${paramIndex}`;
            params.push(`%${establecimiento}%`);
            paramIndex++;
        }
        
        if (numero_ot) {
            query += ` AND i.numero_ot ILIKE $${paramIndex}`;
            params.push(`%${numero_ot}%`);
            paramIndex++;
        }
        
        query += ` ORDER BY i.fecha_asignacion DESC`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener OTs' });
    }
});

app.get('/api/levantamiento/ot-detalle/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const otResult = await pool.query(
            `SELECT i.*, e.nombre as establecimiento_nombre, u.nombre_completo as ito_nombre
             FROM intervenciones i
             JOIN establecimientos e ON i.establecimiento_id = e.id
             LEFT JOIN usuarios u ON i.ito_id = u.id
             WHERE i.id = $1`,
            [id]
        );
        
        if (otResult.rows.length === 0) {
            return res.status(404).json({ message: 'OT no encontrada' });
        }
        
        const antecedentes = await pool.query(
            'SELECT * FROM antecedentes WHERE intervencion_id = $1 ORDER BY created_at DESC',
            [id]
        );
        
        res.json({
            ...otResult.rows[0],
            antecedentes: antecedentes.rows
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener detalle de OT' });
    }
});

app.put('/api/levantamiento/reasignar/:id', async (req, res) => {
    const { id } = req.params;
    const { nuevo_ito_id, motivo } = req.body;
    
    try {
        const otActual = await pool.query('SELECT ito_id FROM intervenciones WHERE id = $1', [id]);
        
        if (otActual.rows.length === 0) {
            return res.status(404).json({ message: 'OT no encontrada' });
        }
        
        await pool.query(
            'UPDATE intervenciones SET ito_id = $1, updated_at = NOW() WHERE id = $2',
            [nuevo_ito_id, id]
        );
        
        await pool.query(
            `INSERT INTO trazabilidad_ito 
             (intervencion_id, ito_anterior_id, ito_nuevo_id, motivo) 
             VALUES ($1, $2, $3, $4)`,
            [id, otActual.rows[0].ito_id, nuevo_ito_id, motivo || 'Reasignación manual']
        );
        
        res.json({ success: true, message: 'OT reasignada correctamente' });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al reasignar OT' });
    }
});

app.get('/api/levantamiento/estados', (req, res) => {
    const estados = [
        'Asignada',
        'Visita Programada',
        'Visita Realizada',
        'Enviada a Proveedor',
        'Validando Presupuesto',
        'Presupuesto Validado'
    ];
    res.json(estados);
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor SIGME 2.0 corriendo en puerto ${PORT}`);
    console.log(`📡 API disponible en http://localhost:${PORT}/api/health`);
});
