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

// A quick health endpoint to wake up Render instances safely.
app.get('/api/health', (req, res) => {
  res.json({ status: 'awake', timestamp: new Date() });
});

// -------------------- Attendance Analysis Endpoint --------------------
app.post('/api/analyze-attendance', (req, res, next) => {
  // Catch Multer errors gracefully so we don't crash and break CORS
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
You are an intelligent attendance analyzer. 
I have attached a PDF report showing my attendance for my college classes (Date, Subject, A, P, or Cancelled).

1. Extract the student's metadata from the report header: full name, semester, program name, academic year, and the attendance report duration (start date, end date).
2. Precisely count the attended and total lectures for each explicit subject.
3. Do NOT include "Cancelled" classes in the total lecture count.

Return ONLY a raw, complete JSON object exactly matching this schema:
{
  "studentName": "Full Name",
  "semester": "Semester III",
  "program": "B.Tech Computer Science",
  "academicYear": "2025-2026",
  "reportStartDate": "01 Jan 2025",
  "reportEndDate": "30 Apr 2025",
  "subjects": [
    {
      "name": "Subject Name Here",
      "attended": 10,
      "total": 12
    }
  ]
}

If a metadata field is not found in the report, set its value to an empty string "".
`;

    const pdfPart = {
      inlineData: {
        mimeType: req.file.mimetype,
        data: req.file.buffer.toString("base64")
      }
    };

    // Note: The user manually updated this to use gemini-2.5-flash which is perfect.
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              pdfPart
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      },
      { 
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const insights = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{"subjects":[]}';

    res.json({ success: true, insights });
  } catch (err) {
    console.error("Attendance Analysis Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Failed to analyze attendance report. See backend logs.' });
  }
});

// Global Error Handler to guarantee JSON responses (ensures CORS works on crashes)
app.use((err, req, res, next) => {
  console.error("Critical Server Error:", err);
  res.status(500).json({ success: false, error: `Critical server error: ${err.message}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
