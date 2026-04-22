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
const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-lite',
];

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
        throw err;
      }
    }
  }
  throw lastError;
}

// ── SSE helper ───────────────────────────────────────────────────────────────
/**
 * Send one SSE event.
 * @param {import('express').Response} res
 * @param {string} event  - event name (matches frontend step keys)
 * @param {object} data   - any extra payload
 */
function sendEvent(res, event, data = {}) {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ event, ...data })}\n\n`);
}

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'awake', timestamp: new Date() });
});

// ── Attendance Analysis Endpoint — SSE streaming ─────────────────────────────
//
//  The response is a text/event-stream.  Events emitted in order:
//    file_received   — multer parsed the upload
//    pdf_encoded     — base64 encoding done, about to call AI
//    ai_request_sent — HTTP request to Gemini fired
//    ai_responded    — Gemini returned a response
//    parsing         — JSON parsing started
//    done            — contains the final {success, insights} payload
//    error           — contains {message} on any failure
//
app.post('/api/analyze-attendance', (req, res, next) => {
  upload.single('report')(req, res, function (err) {
    if (err) {
      console.error('Multer Error:', err);
      return res.status(400).json({ success: false, error: `File Upload Error: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering if present
  res.flushHeaders();

  try {
    if (!req.file) {
      sendEvent(res, 'error', { message: 'No PDF file provided under the "report" field.' });
      return res.end();
    }
    if (req.file.mimetype !== 'application/pdf') {
      sendEvent(res, 'error', { message: 'Only PDF files are accepted.' });
      return res.end();
    }

    console.log(`Received PDF: ${req.file.originalname} (${req.file.size} bytes)`);
    sendEvent(res, 'file_received', { filename: req.file.originalname, bytes: req.file.size });

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

    // Encode PDF to base64
    const pdfPart = {
      inlineData: {
        mimeType: req.file.mimetype,
        data: req.file.buffer.toString('base64'),
      },
    };
    sendEvent(res, 'pdf_encoded');

    // Fire AI request
    sendEvent(res, 'ai_request_sent');
    const response = await callWithFallback(prompt, pdfPart);
    sendEvent(res, 'ai_responded');

    // Parse
    sendEvent(res, 'parsing');
    const insights = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"subjects":[]}';

    // Done — send final payload and close stream
    sendEvent(res, 'done', { success: true, insights });
    res.end();

  } catch (err) {
    console.error('Attendance Analysis Error:', err.response?.data || err.message);
    sendEvent(res, 'error', { message: 'Failed to analyze attendance report. See backend logs.' });
    res.end();
  }
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Critical Server Error:', err);
  res.status(500).json({ success: false, error: `Critical server error: ${err.message}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
