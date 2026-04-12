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
Analyze the report and provide a brief, supportive summary to the student.
1. Highlight which subjects are doing well.
2. Clearly identify any subjects where attendance is dangerously low or missed frequently.
3. Provide an encouraging 2-3 sentence overall summary.
4. Highlight explicitly if there are "Cancelled" classes.

Please format your ENTIRE response cleanly in Markdown.
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
        ]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const insights = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No insights generated.';

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
