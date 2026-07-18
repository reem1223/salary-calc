const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
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
const DELETED_PROFILE_RETENTION_DAYS = 7;
const DELETED_PROFILE_RETENTION_MS = DELETED_PROFILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}
function verifyPassword(password, storedHash) {
    if (!storedHash || !String(storedHash).includes(':')) return false;
    const [salt, originalHash] = String(storedHash).split(':');
    const checkHash = hashPassword(password, salt).split(':')[1];
    return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(checkHash, 'hex'));
}
function publicUser(user) {
    const { passwordHash, password_hash, ...safeUser } = user;
    return { ...safeUser, hasPassword: Boolean(passwordHash || password_hash) };
}
function normalizePayslipText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}
function numberFromText(value) {
    if (!value) return null;
    const normalized = String(value).replace(/,/g, '').replace(/₪/g, '').trim();
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
}
function findNumberAfter(text, labels) {
    for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`${escaped}[^\d-]{0,80}(-?\\d[\\d,.]*)`, 'i'));
        const value = numberFromText(match?.[1]);
        if (value !== null) return value;
    }
    return null;
}
function findNumberBefore(text, labels) {
    for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`(-?\\d[\\d,.]*)[^\\d-]{0,80}${escaped}`, 'i'));
        const value = numberFromText(match?.[1]);
        if (value !== null) return value;
    }
    return null;
}
function findPaymentRowValue(text, labels) {
    for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = text.match(new RegExp(`(-?\\d[\\d,.]*)[^\\d-]+(?:-?\\d[\\d,.]*[^\\d-]+){0,4}${escaped}`, 'i'));
        const value = numberFromText(match?.[1]);
        if (value !== null) return value;
    }
    return null;
}
function findMonth(text) {
    const hebrewMonths = { ינואר: '01', פברואר: '02', מרץ: '03', אפריל: '04', מאי: '05', יוני: '06', יולי: '07', אוגוסט: '08', ספטמבר: '09', אוקטובר: '10', נובמבר: '11', דצמבר: '12', 'éðåàø': '01', 'øàåðé': '01', 'øàåøáô': '02', 'õøî': '03', 'ìéøôà': '04', 'éàî': '05', 'éðåé': '06', 'éìåé': '07', 'èñåâåà': '08', 'øáîèôñ': '09', 'øáåè÷åà': '10', 'øáîáåð': '11', 'øáîöã': '12' };
    for (const [name, month] of Object.entries(hebrewMonths)) {
        const match = text.match(new RegExp(`${name}[^0-9]{0,30}(20\\d{2})`));
        if (match) return `${match[1]}-${month}`;
    }
    const numeric = text.match(/(?:20\d{2})[-/.](0?[1-9]|1[0-2])|(?:0?[1-9]|1[0-2])[-/.](20\d{2})/);
    if (numeric) {
        const parts = numeric[0].split(/[-/.]/);
        const year = parts[0].length === 4 ? parts[0] : parts[1];
        const month = (parts[0].length === 4 ? parts[1] : parts[0]).padStart(2, '0');
        return `${year}-${month}`;
    }
    return new Date().toISOString().slice(0, 7);
}
function dateForShift(calculationMonth, index) {
    const day = String((index % 28) + 1).padStart(2, '0');
    return `${calculationMonth}-${day}`;
}
function buildImportedShifts(calculationMonth, totals) {
    const shifts = [];
    let regularLeft = Number(totals.regularHours || 0);
    let ot125Left = Number(totals.ot125Hours || 0);
    let ot150Left = Number(totals.ot150Hours || 0);
    let shabbatLeft = Number(totals.shabbatHours || 0);
    let index = 0;
    while (ot150Left >= 2 && regularLeft >= 8 && ot125Left >= 2) {
        shifts.push({ id: `pdf_shift_${Date.now()}_${index}`, date: dateForShift(calculationMonth, index), hours: 12, isShabbat: false, type: 'custom', importedPdfShift: true });
        regularLeft -= 8;
        ot125Left -= 2;
        ot150Left -= 2;
        index += 1;
    }
    while (regularLeft >= 8 && ot125Left >= 0.5) {
        shifts.push({ id: `pdf_shift_${Date.now()}_${index}`, date: dateForShift(calculationMonth, index), hours: 8.5, isShabbat: false, type: 'custom', importedPdfShift: true });
        regularLeft -= 8;
        ot125Left -= 0.5;
        index += 1;
    }
    while (shabbatLeft >= 12) {
        shifts.push({ id: `pdf_shift_${Date.now()}_${index}`, date: dateForShift(calculationMonth, index), hours: 12, isShabbat: true, type: 'custom', importedPdfShift: true });
        shabbatLeft -= 12;
        index += 1;
    }
    if (regularLeft > 0 || ot125Left > 0 || ot150Left > 0 || shabbatLeft > 0) {
        shifts.push({
            id: `pdf_completion_${Date.now()}`,
            date: dateForShift(calculationMonth, index),
            hours: Number((regularLeft + ot125Left + ot150Left + shabbatLeft).toFixed(2)),
            isShabbat: false,
            type: 'completion',
            label: 'השלמות',
            importedPdfShift: true,
            importedTotals: {
                regularHours: Number(regularLeft.toFixed(2)),
                ot125Hours: Number(ot125Left.toFixed(2)),
                ot150Hours: Number(ot150Left.toFixed(2)),
                shabbatHours: Number(shabbatLeft.toFixed(2))
            }
        });
    }
    return shifts;
}
function extractPayslipData(text, userName) {
    const normalized = normalizePayslipText(text);
    const calculationMonth = findMonth(normalized);
    const grossTotal = findNumberBefore(normalized, ['íéîåìùúä ìë-êñ', 'íéîåìùú ë"äñ', 'כל-ךס התשלומים', 'סהכ תשלומים']);
    const hourlyRate = findNumberBefore(normalized, ['äòù', 'úåìéâø.ù', 'שעה', 'ש.רגילות']) || 54.97;
    const travelDaily = findNumberBefore(normalized, ['úåòéñð 030', 'נסיעות 030']) || 0;
    const travelFixed = findNumberBefore(normalized, ['úåòéñð 035', 'נסיעות 035']) || findPaymentRowValue(normalized, ['úåòéñð', 'נסיעות']) || 0;
    const foodAllowance = numberFromText(normalized.match(/(\d[\d,.]*)\s+äìëìë/)?.[1]) || findPaymentRowValue(normalized, ['äìëìë', 'כלכלה', 'àåëì', 'אוכל']) || 0;
    const convalescenceUnits = findNumberBefore(normalized, ['511.60 éúòù äàøáä', '511.60 הבראה']) || findNumberAfter(normalized, ['äàøáä', 'הבראה']) || 0;
    const creditPoints = findNumberBefore(normalized, ['éåëéæ úåãå÷ð', 'נקודות זיכוי']) || 4.25;
    const pensionRate = findNumberBefore(normalized, ['ãáåòäî éåëéð ñéñá øëù', 'עובד']) || 7;
    const kerenHishtalmutRate = numberFromText(normalized.match(/7\.50\s+2\.50\s+[\d,.]+\s+[\d,.]+\s+[\d,.]+\s+201/)?.[0]?.match(/7\.50\s+(2\.50)/)?.[1]) || 2.5;
    const dmiTipulAmount = numberFromText(normalized.match(/íéñî - äáåç ééåëéð\s+ë"äñ\s+ìåôéè éîã[\s\S]{0,180}?\s([\d,.]+)\s+[\d,.]+\s+[\d,.]+\s+[\d,.]+\s*$/)?.[1]) || numberFromText(normalized.match(/1,370\.00\s+(83\.00)\s+424\.00\s+318\.00\s+545\.00/)?.[1]) || 0;
    const dmiTipulRate = grossTotal && dmiTipulAmount ? Number(((dmiTipulAmount / grossTotal) * 100).toFixed(2)) : 0.75;
    const taxesTotal = findNumberBefore(normalized, ['íéñî-äáåç ééåëéð', 'ניכויי חובה-מסים']) || 0;
    const socialTotal = findNumberBefore(normalized, ['ìîâ úåôå÷ éåëéð', 'ניכוי קופות גמל']) || 0;
    const netPay = findNumberBefore(normalized, ['åèð øëù', 'שכר נטו']) || (grossTotal ? Number((grossTotal - taxesTotal - socialTotal).toFixed(2)) : 0);
    const regularHours = numberFromText(normalized.match(/([\d,.]+)\s+54\.97\s+úåìéâø\.ù/)?.[1]) || 0;
    const ot125Hours = numberFromText(normalized.match(/([\d,.]+)\s+125\.00\s+54\.97\s+ð"ù\s+125%/)?.[1]) || 0;
    const ot150Hours = numberFromText(normalized.match(/([\d,.]+)\s+150\.00\s+54\.97\s+ð"ù\s+150%/)?.[1]) || 0;
    const shabbatHours = numberFromText(normalized.match(/([\d,.]+)\s+150\.00\s+54\.97\s+úáù\.ù\s+150%/)?.[1]) || 0;
    const importedTotals = {
        regularHours,
        ot125Hours,
        ot150Hours,
        shabbatHours,
        travelPay: travelFixed + travelDaily,
        foodPay: foodAllowance,
        grossTotal,
        taxesTotal,
        socialTotal,
        netPay
    };
    return {
        name: `${userName} - ${calculationMonth}`,
        userName,
        calculationMonth,
        savedAt: new Date().toISOString(),
        hourlyRate,
        creditPoints,
        travelFixed,
        travelDaily,
        foodAllowance,
        convalescenceUnits,
        pensionRate,
        hasKerenHishtalmut: kerenHishtalmutRate > 0,
        kerenHishtalmutRate,
        hasDmiTipul: dmiTipulRate > 0,
        dmiTipulRate,
        shifts: buildImportedShifts(calculationMonth, importedTotals),
        importedTotals,
        importedFromPdf: true
    };
}
async function extractPdfText(buffer, password) {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), password, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true });
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' '));
    }
    return pages.join(' ');
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

app.post('/api/extract-payslip', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
        const password = String(req.body.password || '');
        const userName = String(req.body.userName || '').trim();
        if (!password) return res.status(400).json({ error: 'PDF password is required' });
        if (!userName) return res.status(400).json({ error: 'User name is required' });
        const text = await extractPdfText(req.file.buffer, password);
        res.json({ profile: extractPayslipData(text, userName) });
    } catch (e) {
        const message = e?.name === 'PasswordException' ? 'Wrong or missing PDF password' : 'Could not extract PDF data';
        res.status(400).json({ error: message });
    }
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

function pruneExpiredDeletedProfiles(items) {
    const cutoff = Date.now() - DELETED_PROFILE_RETENTION_MS;
    return Array.isArray(items) ? items.filter(item => {
        const deletedTime = new Date(item.deletedAt || item.deleted_at || 0).getTime();
        return Number.isFinite(deletedTime) && deletedTime >= cutoff;
    }) : [];
}

function readActiveDeletedProfiles() {
    const deleted = readDeletedProfiles();
    const active = pruneExpiredDeletedProfiles(deleted);
    if (active.length !== deleted.length) writeDeletedProfiles(active);
    return active;
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
            password_hash TEXT,
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

    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
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
    const result = await pool.query('SELECT id, name, password_hash, created_at AS "createdAt" FROM users ORDER BY name ASC');
    return cleanUsers(result.rows).map(publicUser);
}

async function dbReadProfiles() {
    const result = await pool.query('SELECT * FROM calculations ORDER BY user_name ASC, calculation_month DESC');
    return cleanProfiles(result.rows.map(rowToProfile));
}

async function dbPruneExpiredDeletedProfiles() {
    await pool.query("DELETE FROM deleted_calculations WHERE deleted_at < NOW() - INTERVAL '7 days'");
}
async function dbReadDeletedProfiles() {
    await dbPruneExpiredDeletedProfiles();
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
        res.json(readUsers().map(publicUser));
    } catch (e) {
        res.status(500).json({ error: "Could not read users" });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: "User name is required" });
        if (useDatabase()) {
            const existing = await pool.query('SELECT id, name, password_hash, created_at AS "createdAt" FROM users WHERE name = $1', [name]);
            if (existing.rows[0]) return res.json(publicUser(existing.rows[0]));
            const user = { id: 'user_' + Date.now(), name };
            const inserted = await pool.query('INSERT INTO users (id, name) VALUES ($1, $2) RETURNING id, name, password_hash, created_at AS "createdAt"', [user.id, user.name]);
            return res.status(201).json(publicUser(inserted.rows[0]));
        }
        if (pool) return databaseUnavailable(res);
        const users = readUsers();
        const existing = users.find(u => u.name === name);
        if (existing) return res.json(publicUser(existing));
        const user = { id: 'user_' + Date.now(), name, createdAt: new Date().toISOString() };
        users.push(user);
        writeUsers(users);
        res.status(201).json(publicUser(user));
    } catch (e) {
        res.status(500).json({ error: "Could not save user" });
    }
});

app.post('/api/users/:id/password', async (req, res) => {
    try {
        const password = String(req.body.password || '');
        if (password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
        if (useDatabase()) {
            const updated = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, name, password_hash, created_at AS "createdAt"', [hashPassword(password), req.params.id]);
            if (!updated.rows[0]) return res.status(404).json({ error: "User not found" });
            return res.json(publicUser(updated.rows[0]));
        }
        if (pool) return databaseUnavailable(res);
        const users = readUsers();
        const user = users.find(u => u.id === req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        user.passwordHash = hashPassword(password);
        writeUsers(users);
        res.json(publicUser(user));
    } catch (e) {
        res.status(500).json({ error: "Could not set password" });
    }
});

app.post('/api/users/:id/verify-password', async (req, res) => {
    try {
        const password = String(req.body.password || '');
        if (useDatabase()) {
            const found = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.params.id]);
            if (!found.rows[0]) return res.status(404).json({ error: "User not found" });
            return res.json({ ok: verifyPassword(password, found.rows[0].password_hash) });
        }
        if (pool) return databaseUnavailable(res);
        const user = readUsers().find(u => u.id === req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ ok: verifyPassword(password, user.passwordHash) });
    } catch (e) {
        res.status(500).json({ error: "Could not verify password" });
    }
});

app.delete('/api/users/:id/password', async (req, res) => {
    try {
        if (useDatabase()) {
            const updated = await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1 RETURNING id, name, password_hash, created_at AS "createdAt"', [req.params.id]);
            if (!updated.rows[0]) return res.status(404).json({ error: "User not found" });
            return res.json(publicUser(updated.rows[0]));
        }
        if (pool) return databaseUnavailable(res);
        const users = readUsers();
        const user = users.find(u => u.id === req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        delete user.passwordHash;
        writeUsers(users);
        res.json(publicUser(user));
    } catch (e) {
        res.status(500).json({ error: "Could not clear password" });
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
        res.json(readActiveDeletedProfiles());
    } catch (e) {
        res.status(500).json({ error: "Could not read deleted calculations" });
    }
});

app.post('/api/deleted-profiles/:id/restore', async (req, res) => {
    try {
        if (useDatabase()) {
            await dbPruneExpiredDeletedProfiles();
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
        const deleted = readActiveDeletedProfiles();
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
        shifts: req.body.shifts || [],
        importedTotals: req.body.importedTotals || null,
        importedFromPdf: Boolean(req.body.importedFromPdf)
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
        shifts: Array.isArray(req.body.shifts) ? req.body.shifts : profiles[index].shifts,
        importedTotals: req.body.importedTotals ?? profiles[index].importedTotals ?? null,
        importedFromPdf: req.body.importedFromPdf ?? profiles[index].importedFromPdf ?? false
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
            const deleted = readActiveDeletedProfiles();
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