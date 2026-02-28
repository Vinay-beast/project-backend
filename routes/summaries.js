const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../config/database');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to check book access (same as secureReader)
async function checkBookAccess(bookId, userId) {
    // Check orders (buy/rent)
    const [orders] = await pool.query(`
        SELECT o.*, oi.book_id, b.title, b.content_url, b.content_type, b.page_count, o.mode, o.rental_end
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN books b ON oi.book_id = b.id
        WHERE oi.book_id = ? AND o.user_id = ? AND o.payment_status = 'completed'
        ORDER BY o.created_at DESC
        LIMIT 1
    `, [bookId, userId]);

    // Check gifts
    const [gifts] = await pool.query(`
        SELECT g.*, b.title, b.content_url, b.content_type, b.page_count, 'gift' as mode, NULL as rental_end
        FROM gifts g
        JOIN books b ON b.id = g.book_id
        WHERE g.book_id = ? AND g.recipient_user_id = ?
        ORDER BY g.created_at DESC
        LIMIT 1
    `, [bookId, userId]);

    return orders.length > 0 ? orders[0] : (gifts.length > 0 ? gifts[0] : null);
}

// Extract text from PDF using pdfjs-dist
async function extractPdfText(pdfBuffer, startPage = 1, endPage = null) {
    try {
        // Dynamic import of pdfjs-dist (ES module)
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        
        console.log('📖 Parsing PDF buffer of size:', pdfBuffer.length);
        
        // Load the PDF document
        const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
        const pdfDoc = await loadingTask.promise;
        
        const totalPages = pdfDoc.numPages;
        console.log(`📄 PDF has ${totalPages} pages`);
        
        // Determine page range
        const start = Math.max(1, startPage || 1);
        const end = Math.min(totalPages, endPage || totalPages);
        
        console.log(`📝 Extracting text from pages ${start} to ${end}`);
        
        let fullText = '';
        
        // Extract text from each page in range
        for (let pageNum = start; pageNum <= end; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += `\n--- Page ${pageNum} ---\n${pageText}\n`;
        }
        
        console.log(`✅ Extracted ${fullText.length} characters from ${end - start + 1} pages`);
        
        return {
            text: fullText,
            totalPages: totalPages,
            extractedPages: { start, end }
        };
    } catch (error) {
        console.error('PDF parsing error:', error.message);
        throw new Error('Failed to extract text from PDF: ' + error.message);
    }
}

// Generate summary using Gemini
async function generateSummary(text, bookTitle, pageRange) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `You are a helpful book summary assistant. Please provide a comprehensive summary of the following text from the book "${bookTitle}" (${pageRange}).

Your summary should include:
1. **Main Plot/Content Summary** (2-3 paragraphs)
2. **Key Characters/Concepts** mentioned
3. **Important Events/Points** (bullet points)
4. **Themes** explored in this section

Text to summarize:
${text.substring(0, 30000)} 

Please provide a well-structured, engaging summary that captures the essence of this content.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('Gemini API error:', error);
        throw new Error('Failed to generate summary: ' + error.message);
    }
}

// POST /api/summaries/generate - Generate summary for a page range
router.post('/generate', auth, async (req, res) => {
    try {
        const { bookId, startPage, endPage } = req.body;
        const userId = req.user.userId || req.user.id;

        if (!bookId) {
            return res.status(400).json({ message: 'Book ID is required' });
        }

        console.log(`📚 Summary request: bookId=${bookId}, pages ${startPage}-${endPage}, userId=${userId}`);

        // Check if user has access to the book
        const access = await checkBookAccess(bookId, userId);
        if (!access) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        // Check rental expiry
        if (access.mode === 'rent' && access.rental_end) {
            const now = new Date();
            const expiryDate = new Date(access.rental_end);
            if (now > expiryDate) {
                return res.status(403).json({ message: 'Your rental period has expired' });
            }
        }

        if (!access.content_url) {
            return res.status(404).json({ message: 'Book content not available' });
        }

        console.log(`📥 Fetching PDF from Azure: ${access.content_url}`);

        // Fetch PDF from Azure
        const pdfResponse = await fetch(access.content_url);
        if (!pdfResponse.ok) {
            return res.status(404).json({ message: 'Failed to fetch book content' });
        }

        const pdfBuffer = await pdfResponse.buffer();
        console.log(`📄 PDF downloaded, size: ${pdfBuffer.length} bytes`);

        // Extract text from PDF
        const extracted = await extractPdfText(pdfBuffer, startPage, endPage);
        console.log(`📝 Extracted ${extracted.text.length} characters from ${extracted.totalPages} pages`);

        if (!extracted.text || extracted.text.trim().length < 100) {
            return res.status(400).json({
                message: 'Could not extract enough text from PDF. The book may be scanned images.'
            });
        }

        // Generate summary using Gemini
        const pageRange = endPage
            ? `Pages ${startPage || 1} to ${endPage}`
            : `Full book (${extracted.totalPages} pages)`;

        console.log(`🤖 Generating summary for: ${access.title}, ${pageRange}`);

        const summary = await generateSummary(extracted.text, access.title, pageRange);

        console.log(`✅ Summary generated successfully`);

        res.json({
            success: true,
            bookId,
            bookTitle: access.title,
            pageRange,
            totalPages: extracted.totalPages,
            summary
        });

    } catch (error) {
        console.error('Summary generation error:', error);
        res.status(500).json({
            message: 'Failed to generate summary',
            error: error.message
        });
    }
});

// GET /api/summaries/book-info/:bookId - Get book info for summary UI
router.get('/book-info/:bookId', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.userId || req.user.id;

        const access = await checkBookAccess(bookId, userId);
        if (!access) {
            return res.status(403).json({ message: 'You do not have access to this book' });
        }

        res.json({
            bookId,
            title: access.title,
            totalPages: access.page_count || 'Unknown',
            hasAccess: true
        });

    } catch (error) {
        console.error('Book info error:', error);
        res.status(500).json({ message: 'Failed to get book info' });
    }
});

module.exports = router;
