import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── Model Fallback Chain ──────────────────────────────────────────────────────
// Tried top-to-bottom; advances to the next on HTTP 503 (model overloaded).
const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-lite',
];

/**
 * Calls the Gemini generateContent API, trying each model in GEMINI_MODELS
 * order. Falls back to the next model on 503 overloaded errors only.
 * Throws on any other error or when all models are exhausted.
 */
async function callWithFallback(prompt, pdfPart) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`[Gemini] Trying model: ${model}`);
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }, pdfPart] }],
          generationConfig: { responseMimeType: 'application/json' },
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log(`[Gemini] Success with model: ${model}`);
      return response;
    } catch (err) {
      if (err.response?.status === 503) {
        console.warn(`[Gemini] ${model} is overloaded (503), trying next fallback...`);
        lastError = err;
      } else {
        throw err; // Non-503 errors propagate immediately
      }
    }
  }
  throw lastError; // All models exhausted
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'awake', timestamp: new Date() });
});

// ── Attendance Analysis Endpoint (Web) ────────────────────────────────────────
app.post('/api/analyze-attendance', (req, res, next) => {
  upload.single('report')(req, res, function (err) {
    if (err) {
      console.error("Multer Error:", err);
      return res.status(400).json({ success: false, error: `File Upload Error: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file provided under the "report" field.' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ success: false, error: 'Only PDF files are accepted.' });
    }

    console.log(`Received PDF: ${req.file.originalname} (${req.file.size} bytes)`);

    const prompt = `
You are a precise attendance data extractor. Accuracy is critical — a student's academic standing depends on this.

I have attached a college attendance PDF report. It contains rows with: Date, Subject, and a status column marked as one of:
- "P" = Present (student attended)
- "A" = Absent (student did NOT attend)

STEP-BY-STEP INSTRUCTIONS:
1. First, extract metadata from the report header: student full name, semester, program, academic year, report start date, and report end date.
2. Identify every unique subject name in the report.
3. For EACH subject, go through EVERY row belonging to that subject and:
   - Count "P" entries → this is "attended"
   - Count "A" entries → add to total but NOT to attended
   - SKIP any "Cancelled" entries entirely — do NOT count them in attended OR total
   - "total" = number of "P" entries + number of "A" entries (excluding Cancelled)
4. Double-check your counts by verifying: attended + absent = total for each subject.

Return ONLY a JSON object matching this exact schema:
{
  "studentName": "Full Name",
  "semester": "Semester III",
  "program": "B.Tech Computer Science",
  "academicYear": "2025-2026",
  "reportStartDate": "01 Jan 2025",
  "reportEndDate": "30 Apr 2025",
  "subjects": [
    {
      "name": "Subject Name",
      "attended": 10,
      "total": 12
    }
  ]
}

RULES:
- "attended" must NEVER be greater than "total".
- "total" must NEVER include Cancelled classes.
- If a metadata field is not found, use an empty string "".
- Do NOT guess or approximate. Count every single row precisely.
`;

    const pdfPart = {
      inlineData: {
        mimeType: req.file.mimetype,
        data: req.file.buffer.toString("base64")
      }
    };

    const response = await callWithFallback(prompt, pdfPart);
    const insights = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"subjects":[]}';

    res.json({ success: true, insights });
  } catch (err) {
    console.error("Attendance Analysis Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to analyze attendance report. See backend logs.' });
  }
});

// ── Setup Data Extraction Endpoint (Android) ──────────────────────────────────
app.post('/api/extract-setup-data', (req, res, next) => {
  upload.single('report')(req, res, function (err) {
    if (err) {
      console.error("Multer Error:", err);
      return res.status(400).json({ success: false, error: `File Upload Error: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file provided under the "report" field.' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ success: false, error: 'Only PDF files are accepted.' });

    console.log(`Received PDF for Setup: ${req.file.originalname} (${req.file.size} bytes)`);

    const prompt = `
You are a precise data extractor. I have attached a college attendance PDF report.
Accuracy is critical — a student's academic standing depends on this.

STEP-BY-STEP INSTRUCTIONS:
1. Extract metadata from the report header: student full name, program (course), academic year.
2. Determine the semester as a number if possible, or string.
3. Identify every unique subject name in the report.
4. Extract every individual attendance record listed in the report.
   - Go through the document row by row.
   - For every row that has a date and subject:
     - Extract the date (convert to YYYY-MM-DD).
     - Extract the subject name exactly.
     - Extract the status ("P" = Present, "A" = Absent)..

Return ONLY a JSON object matching exactly this schema:
{
  "studentName": "Full Name",
  "course": "B.Tech Computer Science",
  "year": "2025-2026",
  "semester": "Semester III",
  "subjects": [
    "Subject 1",
    "Subject 2"
  ],
  "attendanceRecords": [
    {
      "date": "2025-01-20",
      "subject": "Subject Name",
      "status": "P"
    }
  ]
}

RULES:
- "attendanceRecords" must be exhaustive. If there are 50 rows in the PDF, there must be 50 entries in the JSON.
- Do NOT hallucinate a timetable.
- Provide ONLY the JSON. No markdown formatting.
`;

    const pdfPart = {
      inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") }
    };

    const response = await callWithFallback(prompt, pdfPart);
    let dataObj = {};
    try {
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const cleanedStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
      dataObj = JSON.parse(cleanedStr);
    } catch (_) { }

    // Post-process: Deterministically construct timetable and calculate lectureNumbers
    if (Array.isArray(dataObj.attendanceRecords)) {
      const dailySubjectCounts = {};
      const timetableMap = {};

      dataObj.attendanceRecords.forEach(record => {
        if (!record.date || !record.subject) return;

        // Normalize date to YYYY-MM-DD to avoid JS Date parsing inconsistencies
        const dateMatch = record.date.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!dateMatch) return;

        const [_, year, month, day] = dateMatch;
        // Construct date using UTC to avoid timezone shifts during getDay()
        const dateObj = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));

        if (isNaN(dateObj.getTime())) return;

        // 1. Assign lectureNumber (1st, 2nd, etc. for the same date & subject)
        const countKey = `${record.date}_${record.subject}`;
        dailySubjectCounts[countKey] = (dailySubjectCounts[countKey] || 0) + 1;
        record.lectureNumber = dailySubjectCounts[countKey];

        // 2. Track maximum occurrences to build the timetable
        let dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 1 = Monday
        if (dayOfWeek === 0) dayOfWeek = 7; // Convert to Mon=1...Sun=7

        if (!timetableMap[dayOfWeek]) timetableMap[dayOfWeek] = {};
        if (!timetableMap[dayOfWeek][record.subject]) {
          timetableMap[dayOfWeek][record.subject] = { maxDaily: 0, currentDaily: {} };
        }

        const stats = timetableMap[dayOfWeek][record.subject];
        stats.currentDaily[record.date] = (stats.currentDaily[record.date] || 0) + 1;

        if (stats.currentDaily[record.date] > stats.maxDaily) {
          stats.maxDaily = stats.currentDaily[record.date];
        }
      });

      // 3. Assemble the final timetable array
      const timetable = [];
      for (const [dayStr, subMap] of Object.entries(timetableMap)) {
        const dayOfWeek = parseInt(dayStr);
        const subjects = [];

        // Sort subjects by name for consistency (since we don't know the exact order)
        const sortedSubjectNames = Object.keys(subMap).sort();

        for (const subjectName of sortedSubjectNames) {
          const stats = subMap[subjectName];
          for (let i = 0; i < stats.maxDaily; i++) {
            subjects.push(subjectName);
          }
        }
        timetable.push({ dayOfWeek, subjects });
      }
      dataObj.timetable = timetable;
    }

    res.json({ success: true, data: JSON.stringify(dataObj) });
  } catch (err) {
    console.error("Extraction Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to extract setup data.' });
  }
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Critical Server Error:", err);
  res.status(500).json({ success: false, error: `Critical server error: ${err.message}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
