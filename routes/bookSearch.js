// ============================================
// BOOK SEARCH API - SIMPLIFIED AI PIPELINE
// Uses OCR + Groq AI to identify books
// Then checks database for availability
// ============================================

const router = require('express').Router();
const multer = require('multer');
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const { AzureKeyCredential } = require('@azure/search-documents');
const https = require('https');
const pool = require('../config/database');

// Multer config for image uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
        }
    }
});

// ============================================
// AZURE DOCUMENT INTELLIGENCE (OCR)
// ============================================

const documentClient = new DocumentAnalysisClient(
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY)
);

// Groq API Config
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'api.groq.com';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ============================================
// AGENT DEFINITIONS
// ============================================

const AGENTS = {
    OCR: {
        name: '🖼️ OCR Agent',
        role: 'Extract text from uploaded image using Azure Document Intelligence'
    },
    BOOK_IDENTIFIER: {
        name: '📚 Book Identifier Agent',
        role: 'Identify the book from extracted text',
        systemPrompt: `You are a Book Identification Expert. Your job is to identify which book a text excerpt belongs to.

Given OCR-extracted text from a book page, identify:
1. book_title: The most likely book title (be specific, use the exact common title)
2. author: The author's name if you can determine it
3. confidence: How confident you are (0-100)
4. reasoning: Brief explanation of why you think this is the book

Consider:
- Writing style and tone
- Key phrases, terms, or concepts
- Character names or story elements
- Famous quotes or passages you recognize
- Genre indicators

IMPORTANT: Return the EXACT book title as it would appear in a bookstore or database.
For example: "Rich Dad Poor Dad" not "Rich Dad, Poor Dad" or "RICH DAD POOR DAD"

RESPOND ONLY WITH VALID JSON:
{"book_title": "...", "author": "...", "confidence": 85, "reasoning": "..."}`
    },
    RESPONSE: {
        name: '🤖 Response Agent',
        role: 'Generate user-friendly response',
        systemPrompt: `You are a friendly assistant. Generate a helpful response about the book identification.

Given the book identification result and database match status, create a friendly message.

If book is available: Encourage the user to check it out and mention it's available for purchase.
If book is not available: Politely inform that we identified the book but don't have it in our collection.

Keep it brief and friendly (2-3 sentences max).

RESPOND ONLY WITH VALID JSON:
{"message": "...", "recommendation": "..."}`
    }
};

// ============================================
// GROQ API HELPER
// ============================================

async function callGroqAgent(agentType, userMessage, context = '') {
    const agent = AGENTS[agentType];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${agent.name} starting...`);

    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: agent.systemPrompt },
                { role: 'user', content: context ? `${context}\n\n${userMessage}` : userMessage }
            ],
            temperature: 0.3,
            max_tokens: 1024
        });

        const options = {
            hostname: GROQ_API_URL,
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.error) {
                        console.log(`   ❌ Error: ${result.error.message}`);
                        reject(new Error(result.error.message));
                        return;
                    }

                    const content = result.choices[0]?.message?.content || '';
                    console.log(`   ✅ Response received`);

                    // Parse JSON
                    try {
                        let jsonStr = content;
                        if (content.includes('```json')) {
                            jsonStr = content.split('```json')[1].split('```')[0].trim();
                        } else if (content.includes('```')) {
                            jsonStr = content.split('```')[1].split('```')[0].trim();
                        }
                        resolve(JSON.parse(jsonStr));
                    } catch (parseErr) {
                        resolve({ raw: content });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(requestBody);
        req.end();
    });
}

// ============================================
// DATABASE SEARCH - Find matching book
// ============================================

async function findBookInDatabase(bookTitle, author) {
    console.log(`\n🔍 Searching database for: "${bookTitle}" by ${author || 'Unknown'}`);

    try {
        // Clean up the title for search
        const cleanTitle = bookTitle.toLowerCase().trim();

        // Try multiple search strategies

        // 1. Exact match
        let [rows] = await pool.query(
            'SELECT * FROM books WHERE LOWER(title) = ?',
            [cleanTitle]
        );

        if (rows.length > 0) {
            console.log(`   ✅ Exact match found: "${rows[0].title}"`);
            return rows[0];
        }

        // 2. LIKE match (contains)
        [rows] = await pool.query(
            'SELECT * FROM books WHERE LOWER(title) LIKE ?',
            [`%${cleanTitle}%`]
        );

        if (rows.length > 0) {
            console.log(`   ✅ Partial match found: "${rows[0].title}"`);
            return rows[0];
        }

        // 3. Search with individual words (for titles like "Rich Dad Poor Dad")
        const words = cleanTitle.split(/\s+/).filter(w => w.length > 2);
        if (words.length >= 2) {
            const likeConditions = words.map(() => 'LOWER(title) LIKE ?').join(' AND ');
            const likeParams = words.map(w => `%${w}%`);

            [rows] = await pool.query(
                `SELECT * FROM books WHERE ${likeConditions}`,
                likeParams
            );

            if (rows.length > 0) {
                console.log(`   ✅ Word match found: "${rows[0].title}"`);
                return rows[0];
            }
        }

        // 4. Try author match if title didn't work
        if (author) {
            const cleanAuthor = author.toLowerCase().trim();
            [rows] = await pool.query(
                'SELECT * FROM books WHERE LOWER(author) LIKE ?',
                [`%${cleanAuthor}%`]
            );

            if (rows.length > 0) {
                // Check if any title is somewhat similar
                for (const book of rows) {
                    const bookTitleWords = book.title.toLowerCase().split(/\s+/);
                    const searchWords = cleanTitle.split(/\s+/);
                    const matchCount = searchWords.filter(w => bookTitleWords.some(bw => bw.includes(w) || w.includes(bw))).length;

                    if (matchCount >= 1) {
                        console.log(`   ✅ Author+partial title match: "${book.title}"`);
                        return book;
                    }
                }
            }
        }

        console.log(`   ❌ No match found in database`);
        return null;

    } catch (error) {
        console.error('   ❌ Database search error:', error.message);
        return null;
    }
}

// ============================================
// MAIN SEARCH PIPELINE
// ============================================

async function runBookSearchPipeline(imageBuffer) {
    console.log('\n' + '═'.repeat(60));
    console.log('🔍 BOOK SEARCH PIPELINE STARTED');
    console.log('═'.repeat(60));

    const startTime = Date.now();
    const agentOutputs = {};

    try {
        // ========== AGENT 1: OCR ==========
        console.log('\n🖼️ AGENT 1: OCR - Extracting text from image...');

        const poller = await documentClient.beginAnalyzeDocument(
            'prebuilt-read',
            imageBuffer
        );
        const ocrResult = await poller.pollUntilDone();

        let extractedText = '';
        for (const page of ocrResult.pages || []) {
            for (const line of page.lines || []) {
                extractedText += line.content + '\n';
            }
        }

        if (!extractedText.trim()) {
            throw new Error('No text could be extracted from the image');
        }

        console.log(`   ✅ Extracted ${extractedText.split(/\s+/).length} words`);
        agentOutputs.ocr = {
            agent: AGENTS.OCR.name,
            extractedText: extractedText.trim().substring(0, 500) + '...',
            wordCount: extractedText.split(/\s+/).length
        };

        // ========== AGENT 2: BOOK IDENTIFICATION ==========
        console.log('\n📚 AGENT 2: Identifying book from text...');

        const identificationResult = await callGroqAgent(
            'BOOK_IDENTIFIER',
            `Identify which book this text excerpt is from:\n\n"${extractedText.substring(0, 2000)}"`
        );

        console.log(`   📖 Identified: "${identificationResult.book_title}" by ${identificationResult.author}`);
        console.log(`   📊 Confidence: ${identificationResult.confidence}%`);

        agentOutputs.identification = {
            agent: AGENTS.BOOK_IDENTIFIER.name,
            ...identificationResult
        };

        // ========== AGENT 3: DATABASE SEARCH ==========
        console.log('\n🗄️ AGENT 3: Searching database for book...');

        const dbBook = await findBookInDatabase(
            identificationResult.book_title,
            identificationResult.author
        );

        const isAvailable = dbBook !== null;

        agentOutputs.database = {
            agent: '🗄️ Database Agent',
            searchedTitle: identificationResult.book_title,
            found: isAvailable,
            matchedBook: isAvailable ? {
                id: dbBook.id,
                title: dbBook.title,
                author: dbBook.author,
                price: dbBook.price,
                cover_image: dbBook.cover_image
            } : null
        };

        // ========== AGENT 4: RESPONSE GENERATION ==========
        console.log('\n🤖 AGENT 4: Generating response...');

        const responseContext = `
Book Identified: "${identificationResult.book_title}" by ${identificationResult.author}
Confidence: ${identificationResult.confidence}%
Available in our store: ${isAvailable ? 'YES' : 'NO'}
${isAvailable ? `Store Title: "${dbBook.title}" - Price: $${dbBook.price}` : ''}
`;

        const responseResult = await callGroqAgent(
            'RESPONSE',
            'Generate a friendly response for the user',
            responseContext
        );

        agentOutputs.response = {
            agent: AGENTS.RESPONSE.name,
            ...responseResult
        };

        // ========== FINAL OUTPUT ==========
        const endTime = Date.now();

        console.log('\n' + '═'.repeat(60));
        console.log('✅ BOOK SEARCH PIPELINE COMPLETE');
        console.log(`   ⏱️ Total time: ${endTime - startTime}ms`);
        console.log(`   📚 Book: ${identificationResult.book_title}`);
        console.log(`   ✅ Available: ${isAvailable ? 'YES' : 'NO'}`);
        console.log('═'.repeat(60) + '\n');

        // Return different response based on availability
        if (isAvailable) {
            return {
                success: true,
                found: true,
                result: {
                    identifiedTitle: identificationResult.book_title,
                    identifiedAuthor: identificationResult.author,
                    confidence: identificationResult.confidence,
                    reasoning: identificationResult.reasoning,
                    message: responseResult.message,
                    book: {
                        id: dbBook.id,
                        title: dbBook.title,
                        author: dbBook.author,
                        price: dbBook.price,
                        rental_price: dbBook.rental_price,
                        cover_image: dbBook.cover_image,
                        description: dbBook.description
                    }
                },
                agentInsights: agentOutputs,
                processingTimeMs: endTime - startTime
            };
        } else {
            return {
                success: true,
                found: false,
                result: {
                    identifiedTitle: identificationResult.book_title,
                    identifiedAuthor: identificationResult.author,
                    confidence: identificationResult.confidence,
                    reasoning: identificationResult.reasoning,
                    message: responseResult.message || `We identified this as "${identificationResult.book_title}" but it's not currently available in our store.`
                },
                agentInsights: agentOutputs,
                processingTimeMs: endTime - startTime
            };
        }

    } catch (error) {
        console.error('❌ Pipeline Error:', error);
        return {
            success: false,
            error: error.message,
            agentInsights: agentOutputs
        };
    }
}

// ============================================
// API ROUTES
// ============================================

/**
 * POST /api/book-search/image
 * Upload an image and find which book it belongs to
 */
router.post('/image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No image uploaded'
            });
        }

        console.log(`📸 Received image: ${req.file.originalname} (${req.file.size} bytes)`);

        const result = await runBookSearchPipeline(req.file.buffer);
        res.json(result);

    } catch (error) {
        console.error('Book search error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/book-search/status
 * Check if the service is ready
 */
router.get('/status', async (req, res) => {
    try {
        // Check database connection
        const [rows] = await pool.query('SELECT COUNT(*) as count FROM books');

        res.json({
            status: 'ready',
            booksInDatabase: rows[0].count,
            services: {
                documentIntelligence: !!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
                groq: !!process.env.GROQ_API_KEY,
                database: true
            }
        });
    } catch (error) {
        res.json({
            status: 'error',
            error: error.message,
            services: {
                documentIntelligence: !!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
                groq: !!process.env.GROQ_API_KEY,
                database: false
            }
        });
    }
});

/**
 * GET /api/book-search/test
 * Test endpoint
 */
router.get('/test', (req, res) => {
    res.json({
        message: 'Book Search API is running',
        agents: Object.keys(AGENTS).map(key => ({
            name: AGENTS[key].name,
            role: AGENTS[key].role
        }))
    });
});

module.exports = router;
