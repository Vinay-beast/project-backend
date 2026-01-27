// ============================================
// INDEXING API ROUTES
// Manages the book indexing pipeline
// ============================================

const router = require('express').Router();
const BookIndexingAgent = require('../services/bookIndexingAgent');

// Initialize the indexing agent
let indexingAgent;

try {
    indexingAgent = new BookIndexingAgent();
} catch (error) {
    console.error('Failed to initialize BookIndexingAgent:', error.message);
}

/**
 * POST /api/indexing/run
 * Run the full indexing pipeline (processes all PDFs in blob storage)
 */
router.post('/run', async (req, res) => {
    try {
        if (!indexingAgent) {
            return res.status(500).json({
                success: false,
                error: 'Indexing agent not initialized. Check Azure credentials.'
            });
        }

        console.log('📚 Starting full indexing pipeline...');
        const result = await indexingAgent.runIndexingPipeline();

        res.json({
            success: result.success,
            message: result.success
                ? `Successfully indexed ${result.booksProcessed} books with ${result.chunksCreated} chunks`
                : 'Indexing completed with errors',
            details: result
        });

    } catch (error) {
        console.error('Indexing error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/indexing/book
 * Index a single book (for new uploads)
 */
router.post('/book', async (req, res) => {
    try {
        const { pdfUrl, bookName } = req.body;

        if (!pdfUrl || !bookName) {
            return res.status(400).json({
                success: false,
                error: 'pdfUrl and bookName are required'
            });
        }

        if (!indexingAgent) {
            return res.status(500).json({
                success: false,
                error: 'Indexing agent not initialized'
            });
        }

        const result = await indexingAgent.indexSingleBook(pdfUrl, bookName);
        res.json(result);

    } catch (error) {
        console.error('Single book indexing error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/indexing/stats
 * Get index statistics
 */
router.get('/stats', async (req, res) => {
    try {
        if (!indexingAgent) {
            return res.status(500).json({
                success: false,
                error: 'Indexing agent not initialized'
            });
        }

        const stats = await indexingAgent.getIndexStats();
        res.json(stats);

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/indexing/status
 * Check indexing service status
 */
router.get('/status', (req, res) => {
    res.json({
        status: indexingAgent ? 'ready' : 'not_initialized',
        services: {
            blobStorage: !!process.env.AZURE_STORAGE_CONNECTION_STRING,
            documentIntelligence: !!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
            cognitiveSearch: !!process.env.AZURE_SEARCH_KEY
        }
    });
});

module.exports = router;
