// ============================================
// READING ASSISTANT API ROUTES
// Provides book summaries and insights
// Restricted to users who own the book
// ============================================

const router = require('express').Router();
const auth = require('../middleware/auth');
const pool = require('../config/database');

// Lazy-load the reading assistant agent to prevent server crashes
let readingAssistant = null;
let initError = null;

function getReadingAssistant() {
    if (readingAssistant) return readingAssistant;
    if (initError) return null;

    try {
        const ReadingAssistantAgent = require('../services/readingAssistantAgent');
        readingAssistant = new ReadingAssistantAgent();
        console.log('📚 Reading Assistant Agent loaded successfully');
        return readingAssistant;
    } catch (error) {
        console.error('Failed to initialize ReadingAssistantAgent:', error.message);
        initError = error.message;
        return null;
    }
}

// ============================================
// SUMMARY ENDPOINTS
// ============================================

/**
 * GET /api/reading-assistant/summary/:bookId
 * Get full book summary (requires book ownership)
 */
router.get('/summary/:bookId', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;

        const assistant = getReadingAssistant();
        if (!assistant) {
            return res.status(503).json({
                success: false,
                error: 'Reading assistant service unavailable. Check Azure Search configuration.',
                initError: initError
            });
        }

        // Get book details
        const [books] = await pool.query(
            'SELECT id, title, author FROM books WHERE id = ?',
            [bookId]
        );

        if (books.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Book not found'
            });
        }

        const book = books[0];

        // Check if user has access to this book
        const accessCheck = await assistant.checkBookAccess(userId, bookId);

        if (!accessCheck.hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'You must own this book to view its summary',
                reason: accessCheck.reason
            });
        }

        console.log(`📚 Generating summary for "${book.title}" (User: ${userId}, Access: ${accessCheck.accessType})`);

        // Generate or retrieve cached summary
        const result = await assistant.generateBookSummary(bookId, book.title);

        if (result.success) {
            res.json({
                success: true,
                bookId: parseInt(bookId),
                bookTitle: book.title,
                bookAuthor: book.author,
                accessType: accessCheck.accessType,
                cached: result.cached,
                summary: result.summary,
                centralTheme: result.centralTheme,
                targetAudience: result.targetAudience,
                keyTakeaways: result.keyTakeaways || [],
                memorableIdeas: result.memorableIdeas || [],
                mainConcepts: result.mainConcepts || [],
                practicalApplications: result.practicalApplications || [],
                difficultyLevel: result.difficultyLevel,
                estimatedReadingHours: result.estimatedReadingHours,
                prerequisites: result.prerequisites || [],
                genreTags: result.genreTags || [],
                processingTimeMs: result.processingTimeMs,
                agentInsights: result.agentInsights
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error('Summary endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/reading-assistant/quick-summary/:bookId
 * Get a shorter summary (faster, less detailed)
 */
router.get('/quick-summary/:bookId', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;

        const assistant = getReadingAssistant();
        if (!assistant) {
            return res.status(503).json({ success: false, error: 'Service unavailable' });
        }

        // Get book details
        const [books] = await pool.query(
            'SELECT id, title FROM books WHERE id = ?',
            [bookId]
        );

        if (books.length === 0) {
            return res.status(404).json({ success: false, error: 'Book not found' });
        }

        // Check ownership
        const accessCheck = await assistant.checkBookAccess(userId, bookId);
        if (!accessCheck.hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'You must own this book to view its summary'
            });
        }

        const result = await assistant.generateQuickSummary(bookId, books[0].title);
        res.json(result);

    } catch (error) {
        console.error('Quick summary error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/reading-assistant/check-access/:bookId
 * Check if user has access to a book's summary
 */
router.get('/check-access/:bookId', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;

        const assistant = getReadingAssistant();
        if (!assistant) {
            return res.json({ hasAccess: false, reason: 'Service unavailable' });
        }

        const accessCheck = await assistant.checkBookAccess(userId, bookId);

        // Also check if summary is cached
        let hasCachedSummary = false;
        if (accessCheck.hasAccess) {
            const cached = await pool.query(
                'SELECT id FROM book_summaries WHERE book_id = ? LIMIT 1',
                [bookId]
            );
            hasCachedSummary = cached[0].length > 0;
        }

        res.json({
            ...accessCheck,
            hasCachedSummary
        });

    } catch (error) {
        res.json({ hasAccess: false, reason: error.message });
    }
});

// ============================================
// READING PROGRESS ENDPOINTS
// ============================================

/**
 * GET /api/reading-assistant/progress
 * Get all reading progress for user
 */
router.get('/progress', auth, async (req, res) => {
    try {
        const userId = req.user.id;

        const [progress] = await pool.query(`
            SELECT rp.*, b.title, b.author, b.image_url, b.page_count
            FROM reading_progress rp
            JOIN books b ON rp.book_id = b.id
            WHERE rp.user_id = ?
            ORDER BY rp.last_read_at DESC
        `, [userId]);

        res.json({
            success: true,
            progress: progress.map(p => ({
                bookId: p.book_id,
                title: p.title,
                author: p.author,
                imageUrl: p.image_url,
                progressPercent: p.progress_percent,
                currentPage: p.current_page,
                totalPages: p.page_count,
                lastReadAt: p.last_read_at,
                completedAt: p.completed_at
            }))
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/reading-assistant/progress/:bookId
 * Update reading progress
 */
router.put('/progress/:bookId', auth, async (req, res) => {
    try {
        const { bookId } = req.params;
        const userId = req.user.id;
        const { progressPercent, currentPage } = req.body;

        // Check if user owns the book
        const assistant = getReadingAssistant();
        if (!assistant) {
            return res.status(503).json({ success: false, error: 'Service unavailable' });
        }

        const accessCheck = await assistant.checkBookAccess(userId, bookId);
        if (!accessCheck.hasAccess) {
            return res.status(403).json({ success: false, error: 'Book not owned' });
        }

        // Update or insert progress
        const completedAt = progressPercent >= 100 ? 'CURRENT_TIMESTAMP' : 'NULL';

        await pool.query(`
            INSERT INTO reading_progress (user_id, book_id, progress_percent, current_page)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            progress_percent = VALUES(progress_percent),
            current_page = VALUES(current_page),
            completed_at = ${progressPercent >= 100 ? 'CURRENT_TIMESTAMP' : 'completed_at'}
        `, [userId, bookId, progressPercent || 0, currentPage || 1]);

        res.json({
            success: true,
            message: 'Progress updated'
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// STATUS ENDPOINT
// ============================================

/**
 * GET /api/reading-assistant/status
 * Check service status
 */
router.get('/status', (req, res) => {
    const assistant = getReadingAssistant();
    res.json({
        status: assistant ? 'ready' : 'not_initialized',
        initError: initError,
        features: {
            summaryGeneration: true,
            keyPointsExtraction: true,
            readingProgress: true,
            readingPaths: false // Future feature
        },
        agents: assistant ? [
            { name: 'Content Retriever', status: 'active' },
            { name: 'Summary Generator', status: 'active' },
            { name: 'Key Points Extractor', status: 'active' },
            { name: 'Metadata Analyzer', status: 'active' }
        ] : []
    });
});

/**
 * GET /api/reading-assistant/debug/search/:bookTitle
 * Debug endpoint to test Azure Search (no auth required)
 */
router.get('/debug/search/:bookTitle', async (req, res) => {
    try {
        const { bookTitle } = req.params;
        const assistant = getReadingAssistant();

        if (!assistant) {
            return res.json({
                success: false,
                error: 'Assistant not initialized',
                initError: initError
            });
        }

        // Test the search
        const chunks = await assistant.retrieveBookContent(bookTitle, 5);

        res.json({
            success: true,
            searchedFor: bookTitle,
            chunksFound: chunks.length,
            sampleChunks: chunks.slice(0, 3).map(c => ({
                bookName: c.bookName,
                page: c.page,
                contentPreview: c.content?.substring(0, 200) + '...'
            }))
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/reading-assistant/debug/list-all
 * List all books in Azure Search index
 */
router.get('/debug/list-all', async (req, res) => {
    try {
        const assistant = getReadingAssistant();

        if (!assistant) {
            return res.json({ success: false, error: 'Assistant not initialized' });
        }

        // Wildcard search to get all documents
        const searchResults = await assistant.searchClient.search('*', {
            top: 50,
            select: ['bookName', 'pageNumber']
        });

        const books = new Map();
        let totalDocs = 0;

        for await (const result of searchResults.results) {
            totalDocs++;
            const bookName = result.document.bookName || 'Unknown';
            if (!books.has(bookName)) {
                books.set(bookName, { count: 0, pages: [] });
            }
            const book = books.get(bookName);
            book.count++;
            if (book.pages.length < 5) {
                book.pages.push(result.document.pageNumber);
            }
        }

        res.json({
            success: true,
            totalDocumentsFound: totalDocs,
            uniqueBooks: books.size,
            books: Object.fromEntries(books)
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
