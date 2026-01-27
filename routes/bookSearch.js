// ============================================
// BOOK SEARCH API - 5-AGENT QUERY PIPELINE
// Finds which book a page image belongs to
// ============================================

const router = require('express').Router();
const multer = require('multer');
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');
const https = require('https');

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
// AZURE SERVICE CLIENTS
// ============================================

// Document Intelligence (OCR)
const documentClient = new DocumentAnalysisClient(
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY)
);

// Cognitive Search
const searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT,
    'book-pages-index',
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
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
        role: 'Extract text from uploaded image'
    },
    PROCESSING: {
        name: '🧹 Text Processing Agent',
        role: 'Clean and extract key phrases from OCR text',
        systemPrompt: `You are a Text Processing Agent. Your job is to clean OCR-extracted text and identify key searchable phrases.

Given OCR text from a book page image, extract:
1. cleaned_text: Remove OCR noise, fix obvious typos, format properly
2. key_phrases: Most distinctive phrases (3-5 words each) that would identify this specific book
3. potential_title: If you see what looks like a book title or chapter name
4. potential_author: If you see an author name
5. genre_hints: What genre this text suggests (fiction, non-fiction, self-help, etc.)

RESPOND ONLY WITH VALID JSON:
{"cleaned_text": "...", "key_phrases": [], "potential_title": null, "potential_author": null, "genre_hints": []}`
    },
    SEARCH: {
        name: '🔍 Search Agent',
        role: 'Query Azure Cognitive Search index'
    },
    RANKING: {
        name: '📊 Ranking Agent',
        role: 'Score and rank search results',
        systemPrompt: `You are a Ranking Agent. Your job is to analyze search results and determine the most likely book match.

Given the OCR text and search results, calculate:
1. best_match: The book name with highest confidence
2. confidence_score: 0-100 how confident you are this is the right book
3. page_estimate: Which page this likely is from
4. match_reasons: Why you think this is the right match
5. alternative_matches: Other possible books (if any) with their confidence

Consider:
- Exact phrase matches are strongest evidence
- Multiple chunks from same book = higher confidence  
- Keyword overlap importance
- Context and genre consistency

RESPOND ONLY WITH VALID JSON:
{"best_match": "...", "confidence_score": 85, "page_estimate": 47, "match_reasons": [], "alternative_matches": []}`
    },
    RESPONSE: {
        name: '🤖 Response Agent',
        role: 'Generate human-friendly explanation',
        systemPrompt: `You are a Response Agent. Generate a friendly, clear explanation of how the book was identified.

Given the search results and ranking, create:
1. message: A conversational explanation (2-3 sentences) of which book was found and why
2. confidence_explanation: Why you're confident (or not) about this match
3. excerpt_highlight: A short quote from the matched text that proves the match

Be helpful and clear. If confidence is low, explain why and suggest alternatives.

RESPOND ONLY WITH VALID JSON:
{"message": "...", "confidence_explanation": "...", "excerpt_highlight": "..."}`
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
            extractedText: extractedText.trim(),
            wordCount: extractedText.split(/\s+/).length
        };

        // ========== AGENT 2: TEXT PROCESSING ==========
        console.log('\n🧹 AGENT 2: Processing extracted text...');

        const processingResult = await callGroqAgent(
            'PROCESSING',
            `OCR extracted text:\n${extractedText.substring(0, 2000)}`
        );

        agentOutputs.processing = {
            agent: AGENTS.PROCESSING.name,
            ...processingResult
        };

        // ========== AGENT 3: SEARCH ==========
        console.log('\n🔍 AGENT 3: Searching indexed books...');

        // Build search query from key phrases
        const searchQuery = processingResult.key_phrases?.join(' ') || extractedText.substring(0, 500);

        const searchResults = await searchClient.search(searchQuery, {
            top: 10,
            includeTotalCount: true,
            highlightFields: 'content',
            select: ['bookName', 'pageNumber', 'content', 'chunkIndex']
        });

        const matches = [];
        for await (const result of searchResults.results) {
            matches.push({
                bookName: result.document.bookName,
                pageNumber: result.document.pageNumber,
                content: result.document.content?.substring(0, 300),
                score: result.score
            });
        }

        console.log(`   ✅ Found ${matches.length} potential matches`);

        agentOutputs.search = {
            agent: AGENTS.SEARCH.name,
            query: searchQuery.substring(0, 100) + '...',
            matchCount: matches.length,
            topMatches: matches.slice(0, 5)
        };

        // ========== AGENT 4: RANKING ==========
        console.log('\n📊 AGENT 4: Ranking results...');

        const rankingContext = `
OCR Extracted Text (first 500 chars):
"${extractedText.substring(0, 500)}"

Search Results:
${JSON.stringify(matches.slice(0, 5), null, 2)}

Key Phrases Identified: ${processingResult.key_phrases?.join(', ')}
`;

        const rankingResult = await callGroqAgent(
            'RANKING',
            'Analyze these search results and determine the most likely book match',
            rankingContext
        );

        agentOutputs.ranking = {
            agent: AGENTS.RANKING.name,
            ...rankingResult
        };

        // ========== AGENT 5: RESPONSE ==========
        console.log('\n🤖 AGENT 5: Generating response...');

        const responseContext = `
Best Match: ${rankingResult.best_match}
Confidence: ${rankingResult.confidence_score}%
Page Estimate: ${rankingResult.page_estimate}
Match Reasons: ${rankingResult.match_reasons?.join(', ')}
`;

        const responseResult = await callGroqAgent(
            'RESPONSE',
            'Generate a friendly explanation of the book identification result',
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
        console.log(`   📚 Best match: ${rankingResult.best_match} (${rankingResult.confidence_score}%)`);
        console.log('═'.repeat(60) + '\n');

        return {
            success: true,
            result: {
                bookName: rankingResult.best_match,
                pageNumber: rankingResult.page_estimate,
                confidence: rankingResult.confidence_score,
                message: responseResult.message,
                confidenceExplanation: responseResult.confidence_explanation,
                excerptHighlight: responseResult.excerpt_highlight
            },
            agentInsights: agentOutputs,
            debug: {
                processingTimeMs: endTime - startTime,
                ocrWordCount: agentOutputs.ocr.wordCount,
                searchMatches: matches.length
            }
        };

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
 * Check if the search index is ready
 */
router.get('/status', async (req, res) => {
    try {
        const countResult = await searchClient.search('*', {
            top: 0,
            includeTotalCount: true
        });

        res.json({
            status: 'ready',
            indexName: 'book-pages-index',
            documentCount: countResult.count || 0,
            services: {
                documentIntelligence: !!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
                cognitiveSearch: !!process.env.AZURE_SEARCH_KEY,
                groq: !!process.env.GROQ_API_KEY
            }
        });

    } catch (error) {
        res.json({
            status: 'error',
            error: error.message,
            services: {
                documentIntelligence: !!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
                cognitiveSearch: !!process.env.AZURE_SEARCH_KEY,
                groq: !!process.env.GROQ_API_KEY
            }
        });
    }
});

/**
 * GET /api/book-search/agents
 * Get info about the agents
 */
router.get('/agents', (req, res) => {
    res.json({
        system: '5-Agent Book Search Pipeline',
        description: 'Identifies which book a page image belongs to',
        agents: Object.entries(AGENTS).map(([key, agent]) => ({
            id: key,
            name: agent.name,
            role: agent.role
        })),
        flow: [
            '1. OCR Agent - Extracts text from uploaded image using Azure Document Intelligence',
            '2. Processing Agent - Cleans text and extracts key phrases using Groq AI',
            '3. Search Agent - Queries Azure Cognitive Search index',
            '4. Ranking Agent - Scores results and determines best match using Groq AI',
            '5. Response Agent - Generates human-friendly explanation using Groq AI'
        ]
    });
});

module.exports = router;
