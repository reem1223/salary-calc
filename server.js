const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'calculations.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DELETED_PROFILES_FILE = path.join(DATA_DIR, 'deleted_calculations.json');
const LEGACY_PROFILES_FILE = path.join(__dirname, 'profiles.json');
const LEGACY_USERS_FILE = path.join(__dirname, 'users.json');
const LEGACY_DELETED_PROFILES_FILE = path.join(__dirname, 'deleted_profiles.json');
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;
let databaseReady = false;
let databaseInitError = null;
function useDatabase() {
    return Boolean(pool && databaseReady);
}
function databaseUnavailable(res) {
    return res.status(503).json({ error: "Database is configured but not available", detail: databaseInitError });
}
function isSeedProfile(profile) {
    return ['profile_june_2026', 'profile_feb_2026', 'profile_empty'].includes(profile.id)
        || ['מזרחי ראם - יוני 2026 (בסיס 54.97)', 'מזרחי ראם - פברואר 2026 (בסיס 53.22)', 'סימולטור נקי (משמרות ריקות)'].includes(profile.name);
}
function isSeedUser(user) {
    return ['מזרחי ראם', 'משתמש חדש'].includes(user.name);
}
function cleanProfiles(profiles) {
    return Array.isArray(profiles) ? profiles.filter(profile => !isSeedProfile(profile)) : [];
}
function cleanUsers(users) {
    return Array.isArray(users) ? users.filter(user => !isSeedUser(user)) : [];
}

app.use(cors());
app.use(express.json());

// Serve frontend static file at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'salary_calculator.html'));
});

// Serve frontend if requested directly by file name
app.get('/salary_calculator.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'salary_calculator.html'));
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: !pool || databaseReady,
        databaseConfigured: Boolean(pool),
        databaseReady,
        databaseError: databaseInitError
    });
});

// Helper function to read profiles from file
function readProfiles() {
    try {
        if (!fs.existsSync(DATA_FILE) && fs.existsSync(LEGACY_PROFILES_FILE)) {
            fs.copyFileSync(LEGACY_PROFILES_FILE, DATA_FILE);
        }
        if (!fs.existsSync(DATA_FILE)) {
            writeProfiles([]);
            return [];
        }
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        const profiles = cleanProfiles(JSON.parse(data));
        writeProfiles(profiles);
        return profiles;
    } catch (e) {
        console.error("Error reading database file:", e);
        return [];
    }
}

// Helper function to write profiles to file
function writeProfiles(profiles) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(profiles, null, 4), 'utf8');
        return true;
    } catch (e) {
        console.error("Error writing database file:", e);
        return false;
    }
}

function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 4), 'utf8');
            return fallback;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error("Error reading json file:", e);
        return fallback;
    }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
        return true;
    } catch (e) {
        console.error("Error writing json file:", e);
        return false;
    }
}

function readUsers() {
    if (!fs.existsSync(USERS_FILE) && fs.existsSync(LEGACY_USERS_FILE)) {
        fs.copyFileSync(LEGACY_USERS_FILE, USERS_FILE);
    }
    if (!fs.existsSync(USERS_FILE)) {
        const profiles = readProfiles();
        const initialUsers = Array.from(new Set(profiles.map(p => p.userName || p.name).filter(Boolean)))
            .map(name => ({ id: 'user_' + Buffer.from(name).toString('base64url'), name, createdAt: new Date().toISOString() }));
        writeJsonFile(USERS_FILE, initialUsers);
        return initialUsers;
    }
    const users = cleanUsers(readJsonFile(USERS_FILE, []));
    writeUsers(users);
    return users;
}

function writeUsers(users) {
    return writeJsonFile(USERS_FILE, users);
}

function readDeletedProfiles() {
    if (!fs.existsSync(DELETED_PROFILES_FILE) && fs.existsSync(LEGACY_DELETED_PROFILES_FILE)) {
        fs.copyFileSync(LEGACY_DELETED_PROFILES_FILE, DELETED_PROFILES_FILE);
    }
    return readJsonFile(DELETED_PROFILES_FILE, []);
}

function writeDeletedProfiles(items) {
    return writeJsonFile(DELETED_PROFILES_FILE, items);
}

async function initDatabase() {
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS calculations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            user_name TEXT NOT NULL,
            calculation_month TEXT NOT NULL,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deleted_calculations (
            id TEXT PRIMARY KEY,
            deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            data JSONB NOT NULL
        );
    `);

    await pool.query("DELETE FROM calculations WHERE id IN ('profile_june_2026', 'profile_feb_2026', 'profile_empty') OR name IN ('מזרחי ראם - יוני 2026 (בסיס 54.97)', 'מזרחי ראם - פברואר 2026 (בסיס 53.22)', 'סימולטור נקי (משמרות ריקות)')");
    await pool.query("DELETE FROM users WHERE name IN ('מזרחי ראם', 'משתמש חדש')");

    const userCount = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (userCount.rows[0].count === 0) {
        for (const user of readUsers()) {
            await pool.query('INSERT INTO users (id, name, created_at) VALUES ($1, $2, COALESCE($3::timestamptz, NOW())) ON CONFLICT (id) DO NOTHING', [user.id, user.name, user.createdAt]);
        }
    }

    const profileCount = await pool.query('SELECT COUNT(*)::int AS count FROM calculations');
    if (profileCount.rows[0].count === 0) {
        for (const profile of readProfiles()) {
            await dbSaveProfile(profile);
        }
    }

    const deletedCount = await pool.query('SELECT COUNT(*)::int AS count FROM deleted_calculations');
    if (deletedCount.rows[0].count === 0) {
        for (const item of readDeletedProfiles()) {
            await pool.query('INSERT INTO deleted_calculations (id, deleted_at, data) VALUES ($1, COALESCE($2::timestamptz, NOW()), $3) ON CONFLICT (id) DO NOTHING', [item.id, item.deletedAt, item.profile]);
        }
    }
}

function rowToProfile(row) {
    return {
        ...(row.data || {}),
        id: row.id,
        name: row.name,
        userName: row.user_name,
        calculationMonth: row.calculation_month,
        savedAt: row.saved_at
    };
}

async function dbReadUsers() {
    const result = await pool.query('SELECT id, name, created_at AS "createdAt" FROM users ORDER BY name ASC');
    return cleanUsers(result.rows);
}

async function dbReadProfiles() {
    const result = await pool.query('SELECT * FROM calculations ORDER BY user_name ASC, calculation_month DESC');
    return cleanProfiles(result.rows.map(rowToProfile));
}

async function dbReadDeletedProfiles() {
    const result = await pool.query('SELECT id, deleted_at, data FROM deleted_calculations ORDER BY deleted_at DESC');
    return result.rows.map(row => ({ id: row.id, deletedAt: row.deleted_at, profile: row.data }));
}

async function dbSaveProfile(profile) {
    await pool.query(
        `INSERT INTO calculations (id, name, user_name, calculation_month, saved_at, data)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            user_name = EXCLUDED.user_name,
            calculation_month = EXCLUDED.calculation_month,
            saved_at = NOW(),
            data = EXCLUDED.data`,
        [profile.id, profile.name, profile.userName, profile.calculationMonth, profile]
    );
}

app.get('/api/users', async (req, res) => {
    try {
        if (useDatabase()) return res.json(await dbReadUsers());
        if (pool) return databaseUnavailable(res);
        res.json(readUsers());
    } catch (e) {
        res.status(500).json({ error: "Could not read users" });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: "User name is required" });
        if (useDatabase()) {
            const existing = await pool.query('SELECT id, name, created_at AS "createdAt" FROM users WHERE name = $1', [name]);
            if (existing.rows[0]) return res.json(existing.rows[0]);
            const user = { id: 'user_' + Date.now(), name };
            const inserted = await pool.query('INSERT INTO users (id, name) VALUES ($1, $2) RETURNING id, name, created_at AS "createdAt"', [user.id, user.name]);
            return res.status(201).json(inserted.rows[0]);
        }
        if (pool) return databaseUnavailable(res);
        const users = readUsers();
        const existing = users.find(u => u.name === name);
        if (existing) return res.json(existing);
        const user = { id: 'user_' + Date.now(), name, createdAt: new Date().toISOString() };
        users.push(user);
        writeUsers(users);
        res.status(201).json(user);
    } catch (e) {
        res.status(500).json({ error: "Could not save user" });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        if (useDatabase()) {
            const found = await pool.query('SELECT id, name FROM users WHERE id = $1', [req.params.id]);
            const user = found.rows[0];
            if (!user) return res.status(404).json({ error: "User not found" });
            const calc = await pool.query('SELECT 1 FROM calculations WHERE user_name = $1 LIMIT 1', [user.name]);
            if (calc.rows.length) return res.status(409).json({ error: "Cannot delete user with existing calculations" });
            await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
            return res.json({ message: "User deleted successfully" });
        }
        if (pool) return databaseUnavailable(res);
        const users = readUsers();
        const user = users.find(u => u.id === req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        const profiles = readProfiles();
        const hasCalculations = profiles.some(p => (p.userName || p.name) === user.name);
        if (hasCalculations) return res.status(409).json({ error: "Cannot delete user with existing calculations" });
        const nextUsers = users.filter(u => u.id !== req.params.id);
        writeUsers(nextUsers);
        res.json({ message: "User deleted successfully" });
    } catch (e) {
        res.status(500).json({ error: "Could not delete user" });
    }
});

app.get('/api/deleted-profiles', async (req, res) => {
    try {
        if (useDatabase()) return res.json(await dbReadDeletedProfiles());
        if (pool) return databaseUnavailable(res);
        res.json(readDeletedProfiles());
    } catch (e) {
        res.status(500).json({ error: "Could not read deleted calculations" });
    }
});

app.post('/api/deleted-profiles/:id/restore', async (req, res) => {
    try {
        if (useDatabase()) {
            const found = await pool.query('SELECT id, data FROM deleted_calculations WHERE id = $1', [req.params.id]);
            if (!found.rows[0]) return res.status(404).json({ error: "Backup not found" });
            const restored = { ...found.rows[0].data, restoredAt: new Date().toISOString() };
            const exists = await pool.query('SELECT 1 FROM calculations WHERE id = $1', [restored.id]);
            if (exists.rows.length) restored.id = 'profile_' + Date.now();
            await dbSaveProfile(restored);
            await pool.query('DELETE FROM deleted_calculations WHERE id = $1', [req.params.id]);
            return res.json(restored);
        }
        if (pool) return databaseUnavailable(res);
        const deleted = readDeletedProfiles();
        const index = deleted.findIndex(item => item.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: "Backup not found" });
        const restored = { ...deleted[index].profile, restoredAt: new Date().toISOString() };
        const profiles = readProfiles();
        if (profiles.some(p => p.id === restored.id)) restored.id = 'profile_' + Date.now();
        profiles.push(restored);
        deleted.splice(index, 1);
        writeProfiles(profiles);
        writeDeletedProfiles(deleted);
        res.json(restored);
    } catch (e) {
        res.status(500).json({ error: "Could not restore calculation" });
    }
});

// REST API Endpoints for Profiles
app.get('/api/profiles', async (req, res) => {
    try {
        if (useDatabase()) return res.json(await dbReadProfiles());
        if (pool) return databaseUnavailable(res);
        const profiles = readProfiles();
        res.json(profiles);
    } catch (e) {
        res.status(500).json({ error: "Could not read calculations" });
    }
});

app.post('/api/profiles', async (req, res) => {
    try {
        if (pool && !useDatabase()) return databaseUnavailable(res);
        const profiles = useDatabase() ? [] : readProfiles();
        const newProfile = {
        id: 'profile_' + Date.now(),
        name: req.body.name || "חישוב חודשי חדש",
        userName: req.body.userName || req.body.name || "משתמש חדש",
        calculationMonth: req.body.calculationMonth || new Date().toISOString().slice(0, 7),
        savedAt: new Date().toISOString(),
        hourlyRate: parseFloat(req.body.hourlyRate) || 54.97,
        creditPoints: parseFloat(req.body.creditPoints) || 4.25,
        travelFixed: parseFloat(req.body.travelFixed) || 0,
        travelDaily: parseFloat(req.body.travelDaily) || 0,
        foodAllowance: parseFloat(req.body.foodAllowance) || 4.00,
        convalescenceUnits: parseFloat(req.body.convalescenceUnits) || 0,
        pensionRate: parseFloat(req.body.pensionRate) || 7.0,
        hasKerenHishtalmut: req.body.hasKerenHishtalmut ?? true,
        kerenHishtalmutRate: parseFloat(req.body.kerenHishtalmutRate) || 2.5,
        hasDmiTipul: req.body.hasDmiTipul ?? true,
        dmiTipulRate: parseFloat(req.body.dmiTipulRate) || 0.75,
        shifts: req.body.shifts || []
    };
    
        if (useDatabase()) {
            await dbSaveProfile(newProfile);
        } else {
            profiles.push(newProfile);
            writeProfiles(profiles);
        }
        res.status(201).json(newProfile);
    } catch (e) {
        res.status(500).json({ error: "Could not save calculation" });
    }
});

app.put('/api/profiles/:id', async (req, res) => {
    try {
        if (pool && !useDatabase()) return databaseUnavailable(res);
        const profiles = useDatabase() ? await dbReadProfiles() : readProfiles();
        const index = profiles.findIndex(p => p.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: "Profile not found" });
        }
        
        profiles[index] = {
        ...profiles[index],
        name: req.body.name || profiles[index].name,
        userName: req.body.userName ?? profiles[index].userName ?? profiles[index].name,
        calculationMonth: req.body.calculationMonth ?? profiles[index].calculationMonth,
        savedAt: new Date().toISOString(),
        hourlyRate: Number.isNaN(parseFloat(req.body.hourlyRate)) ? profiles[index].hourlyRate : parseFloat(req.body.hourlyRate),
        creditPoints: Number.isNaN(parseFloat(req.body.creditPoints)) ? profiles[index].creditPoints : parseFloat(req.body.creditPoints),
        travelFixed: Number.isNaN(parseFloat(req.body.travelFixed)) ? profiles[index].travelFixed : parseFloat(req.body.travelFixed),
        travelDaily: Number.isNaN(parseFloat(req.body.travelDaily)) ? profiles[index].travelDaily : parseFloat(req.body.travelDaily),
        foodAllowance: Number.isNaN(parseFloat(req.body.foodAllowance)) ? profiles[index].foodAllowance : parseFloat(req.body.foodAllowance),
        convalescenceUnits: Number.isNaN(parseFloat(req.body.convalescenceUnits)) ? profiles[index].convalescenceUnits : parseFloat(req.body.convalescenceUnits),
        pensionRate: Number.isNaN(parseFloat(req.body.pensionRate)) ? profiles[index].pensionRate : parseFloat(req.body.pensionRate),
        hasKerenHishtalmut: req.body.hasKerenHishtalmut ?? profiles[index].hasKerenHishtalmut,
        kerenHishtalmutRate: Number.isNaN(parseFloat(req.body.kerenHishtalmutRate)) ? profiles[index].kerenHishtalmutRate : parseFloat(req.body.kerenHishtalmutRate),
        hasDmiTipul: req.body.hasDmiTipul ?? profiles[index].hasDmiTipul,
        dmiTipulRate: Number.isNaN(parseFloat(req.body.dmiTipulRate)) ? profiles[index].dmiTipulRate : parseFloat(req.body.dmiTipulRate),
        shifts: Array.isArray(req.body.shifts) ? req.body.shifts : profiles[index].shifts
    };
    
        if (useDatabase()) {
            await dbSaveProfile(profiles[index]);
        } else {
            writeProfiles(profiles);
        }
        res.json(profiles[index]);
    } catch (e) {
        res.status(500).json({ error: "Could not update calculation" });
    }
});

app.delete('/api/profiles/:id', async (req, res) => {
    try {
        if (pool && !useDatabase()) return databaseUnavailable(res);
        let profiles = useDatabase() ? await dbReadProfiles() : readProfiles();
        const index = profiles.findIndex(p => p.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: "Profile not found" });
        }
        
        const deletedProfile = profiles[index];
        const deletedId = 'deleted_' + Date.now();
        if (useDatabase()) {
            await pool.query('INSERT INTO deleted_calculations (id, data) VALUES ($1, $2)', [deletedId, deletedProfile]);
            await pool.query('DELETE FROM calculations WHERE id = $1', [req.params.id]);
        } else {
            const deleted = readDeletedProfiles();
            deleted.push({
                id: deletedId,
                deletedAt: new Date().toISOString(),
                profile: deletedProfile
            });
            profiles = profiles.filter(p => p.id !== req.params.id);
            writeDeletedProfiles(deleted);
            writeProfiles(profiles);
        }
        res.json({ message: "Profile deleted successfully" });
    } catch (e) {
        res.status(500).json({ error: "Could not delete calculation" });
    }
});

initDatabase()
    .then(() => {
        databaseReady = Boolean(pool);
        databaseInitError = null;
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
            console.log(databaseReady ? "Database persistence is enabled" : "Using local JSON persistence");
        });
    })
    .catch((e) => {
        databaseReady = false;
        databaseInitError = e.message || String(e);
        console.error("Database initialization failed.");
        console.error(databaseInitError);
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
            console.log(pool ? "Database is configured but unavailable" : "Using local JSON persistence because database initialization failed");
        });
    });