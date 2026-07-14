const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'profiles.json');

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

// Helper function to read profiles from file
function readProfiles() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            // Write defaults based on your real pay stubs if no file exists yet
            const defaultProfiles = [
                {
                    id: "profile_june_2026",
                    name: "מזרחי ראם - יוני 2026 (בסיס 54.97)",
                    userName: "מזרחי ראם",
                    calculationMonth: "2026-06",
                    hourlyRate: 54.97,
                    creditPoints: 4.25,
                    travelFixed: 272.00,
                    travelDaily: 11.30,
                    foodAllowance: 4.00,
                    convalescenceUnits: 0.41,
                    pensionRate: 7.0,
                    hasKerenHishtalmut: true,
                    kerenHishtalmutRate: 2.5,
                    hasDmiTipul: true,
                    dmiTipulRate: 0.75,
                    shifts: [
                        { id: "s1", date: "2026-06-01", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s2", date: "2026-06-02", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s3", date: "2026-06-03", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s4", date: "2026-06-04", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s5", date: "2026-06-05", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s6", date: "2026-06-08", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s7", date: "2026-06-09", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s8", date: "2026-06-10", hours: 10, isShabbat: false, type: "custom" },
                        { id: "s9", date: "2026-06-11", hours: 9, isShabbat: false, type: "custom" },
                        { id: "s10", date: "2026-06-12", hours: 8.5, isShabbat: false, type: "custom" },
                        { id: "s11", date: "2026-06-15", hours: 12.5, isShabbat: false, type: "custom" },
                        { id: "s12", date: "2026-06-16", hours: 12.5, isShabbat: false, type: "custom" },
                        { id: "s13", date: "2026-06-17", hours: 12, isShabbat: false, type: "custom" },
                        { id: "s14", date: "2026-06-18", hours: 12, isShabbat: false, type: "custom" },
                        { id: "s15", date: "2026-06-19", hours: 2.25, isShabbat: false, type: "custom" },
                        { id: "s16", date: "2026-06-20", hours: 14.75, isShabbat: true, type: "custom" }
                    ]
                },
                {
                    id: "profile_feb_2026",
                    name: "מזרחי ראם - פברואר 2026 (בסיס 53.22)",
                    userName: "מזרחי ראם",
                    calculationMonth: "2026-02",
                    hourlyRate: 53.22,
                    creditPoints: 4.25,
                    travelFixed: 323.00,
                    travelDaily: 11.30,
                    foodAllowance: 4.00,
                    convalescenceUnits: 0.51,
                    pensionRate: 7.0,
                    hasKerenHishtalmut: true,
                    kerenHishtalmutRate: 2.5,
                    hasDmiTipul: true,
                    dmiTipulRate: 0.75,
                    shifts: [
                        { id: "f1", date: "2026-02-01", hours: 12, isShabbat: false, type: "noon" },
                        { id: "f2", date: "2026-02-02", hours: 12, isShabbat: false, type: "noon" },
                        { id: "f3", date: "2026-02-03", hours: 12, isShabbat: false, type: "noon" },
                        { id: "f4", date: "2026-02-04", hours: 12, isShabbat: false, type: "noon" },
                        { id: "f5", date: "2026-02-05", hours: 12, isShabbat: false, type: "noon" }
                    ]
                },
                {
                    id: "profile_empty",
                    name: "סימולטור נקי (משמרות ריקות)",
                    userName: "משתמש חדש",
                    calculationMonth: new Date().toISOString().slice(0, 7),
                    hourlyRate: 54.97,
                    creditPoints: 4.25,
                    travelFixed: 272.00,
                    travelDaily: 11.30,
                    foodAllowance: 4.00,
                    convalescenceUnits: 0.41,
                    pensionRate: 7.0,
                    hasKerenHishtalmut: true,
                    kerenHishtalmutRate: 2.5,
                    hasDmiTipul: true,
                    dmiTipulRate: 0.75,
                    shifts: []
                }
            ];
            fs.writeFileSync(DATA_FILE, JSON.stringify(defaultProfiles, null, 4), 'utf8');
            return defaultProfiles;
        }
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
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

// REST API Endpoints for Profiles
app.get('/api/profiles', (req, res) => {
    const profiles = readProfiles();
    res.json(profiles);
});

app.post('/api/profiles', (req, res) => {
    const profiles = readProfiles();
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
    
    profiles.push(newProfile);
    writeProfiles(profiles);
    res.status(201).json(newProfile);
});

app.put('/api/profiles/:id', (req, res) => {
    const profiles = readProfiles();
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
    
    writeProfiles(profiles);
    res.json(profiles[index]);
});

app.delete('/api/profiles/:id', (req, res) => {
    let profiles = readProfiles();
    const index = profiles.findIndex(p => p.id === req.params.id);
    if (index === -1) {
        return res.status(404).json({ error: "Profile not found" });
    }
    
    profiles = profiles.filter(p => p.id !== req.params.id);
    writeProfiles(profiles);
    res.json({ message: "Profile deleted successfully" });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});