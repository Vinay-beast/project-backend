// backend/routes/googleBooks.js
const router = require('express').Router();
const pool = require('../config/database');
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/admin');
const https = require('https');

// Google Books API base URL (no API key needed for basic search)
const GOOGLE_BOOKS_API = 'https://www.googleapis.com/books/v1/volumes';

// Helper function to fetch from Google Books API
function fetchGoogleBooks(query, maxResults = 20) {
    return new Promise((resolve, reject) => {
        const url = `${GOOGLE_BOOKS_API}?q=${encodeURIComponent(query)}&maxResults=${maxResults}&printType=books`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Failed to parse Google Books response'));
                }
            });
        }).on('error', reject);
    });
}

// Transform Google Books item to our format
function transformGoogleBook(item) {
    const info = item.volumeInfo || {};
    const saleInfo = item.saleInfo || {};
    
    // Get the best available image
    let imageUrl = '';
    if (info.imageLinks) {
        // Prefer larger images, use https
        imageUrl = info.imageLinks.thumbnail || 
                   info.imageLinks.smallThumbnail || 
                   '';
        // Convert to https if needed
        if (imageUrl.startsWith('http://')) {
            imageUrl = imageUrl.replace('http://', 'https://');
        }
    }
    
    // Get price if available
    let price = 0;
    if (saleInfo.listPrice) {
        price = saleInfo.listPrice.amount || 0;
    } else if (saleInfo.retailPrice) {
        price = saleInfo.retailPrice.amount || 0;
    }
    
    // Generate suggested price if not available (based on page count)
    if (price === 0 && info.pageCount) {
        // Rough estimate: ₹2 per page, minimum ₹99
        price = Math.max(99, Math.min(999, Math.round(info.pageCount * 2)));
    } else if (price === 0) {
        price = 199; // Default price
    }
    
    return {
        googleBooksId: item.id,
        title: info.title || 'Unknown Title',
        author: (info.authors || []).join(', ') || 'Unknown Author',
        description: info.description || info.subtitle || '',
        image_url: imageUrl,
        page_count: info.pageCount || 0,
        published_date: info.publishedDate || '',
        publisher: info.publisher || '',
        categories: info.categories || [],
        language: info.language || 'en',
        isbn: (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || 
              (info.industryIdentifiers || []).find(i => i.type === 'ISBN_10')?.identifier || '',
        suggested_price: price,
        preview_link: info.previewLink || '',
        info_link: info.infoLink || ''
    };
}

/**
 * GET /api/google-books/search
 * Search Google Books API
 * Query params: q (search query), maxResults (default 20)
 */
router.get('/search', auth, adminOnly, async (req, res) => {
    try {
        const { q, maxResults = 20 } = req.query;
        
        if (!q || q.trim().length < 2) {
            return res.status(400).json({ message: 'Search query must be at least 2 characters' });
        }
        
        const result = await fetchGoogleBooks(q, Math.min(40, Number(maxResults) || 20));
        
        if (!result.items || !result.items.length) {
            return res.json({ books: [], totalItems: 0 });
        }
        
        const books = result.items.map(transformGoogleBook);
        
        res.json({
            books,
            totalItems: result.totalItems || books.length
        });
    } catch (err) {
        console.error('Google Books search failed:', err);
        res.status(500).json({ message: 'Failed to search Google Books' });
    }
});

/**
 * GET /api/google-books/details/:googleBooksId
 * Get details of a specific book from Google Books
 */
router.get('/details/:googleBooksId', auth, adminOnly, async (req, res) => {
    try {
        const { googleBooksId } = req.params;
        
        const url = `${GOOGLE_BOOKS_API}/${googleBooksId}`;
        
        const result = await new Promise((resolve, reject) => {
            https.get(url, (httpRes) => {
                let data = '';
                httpRes.on('data', chunk => data += chunk);
                httpRes.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse response'));
                    }
                });
            }).on('error', reject);
        });
        
        if (result.error) {
            return res.status(404).json({ message: 'Book not found on Google Books' });
        }
        
        const book = transformGoogleBook(result);
        res.json(book);
    } catch (err) {
        console.error('Google Books details failed:', err);
        res.status(500).json({ message: 'Failed to fetch book details' });
    }
});

/**
 * POST /api/google-books/import
 * Import a book from Google Books into our database
 */
router.post('/import', auth, adminOnly, async (req, res) => {
    try {
        const { 
            googleBooksId,
            title, 
            author, 
            description, 
            image_url, 
            page_count,
            price,
            stock = 10,
            category
        } = req.body;
        
        if (!title || !author) {
            return res.status(400).json({ message: 'Title and author are required' });
        }
        
        // Check if book with same Google Books ID already exists
        if (googleBooksId) {
            const [existing] = await pool.query(
                'SELECT id FROM books WHERE google_books_id = ?',
                [googleBooksId]
            );
            if (existing.length > 0) {
                return res.status(409).json({ 
                    message: 'This book has already been imported',
                    existingBookId: existing[0].id
                });
            }
        }
        
        // Generate unique book ID
        const bookId = 'gb' + Date.now().toString().slice(-8);
        
        // Insert into database
        const sql = `
            INSERT INTO books (id, title, author, description, image_url, price, stock, page_count, category, google_books_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        
        await pool.query(sql, [
            bookId,
            title,
            author,
            description || null,
            image_url || null,
            price || 199,
            stock,
            page_count || null,
            category || null,
            googleBooksId || null
        ]);
        
        // Fetch the newly created book
        const [rows] = await pool.query('SELECT * FROM books WHERE id = ?', [bookId]);
        
        res.json({
            success: true,
            message: 'Book imported successfully',
            book: rows[0]
        });
    } catch (err) {
        console.error('Google Books import failed:', err);
        res.status(500).json({ message: err.message || 'Failed to import book' });
    }
});

/**
 * POST /api/google-books/bulk-import
 * Import multiple books from Google Books
 */
router.post('/bulk-import', auth, adminOnly, async (req, res) => {
    try {
        const { books } = req.body;
        
        if (!Array.isArray(books) || books.length === 0) {
            return res.status(400).json({ message: 'No books provided for import' });
        }
        
        const results = {
            success: [],
            failed: [],
            skipped: []
        };
        
        for (const book of books) {
            try {
                // Check if already exists
                if (book.googleBooksId) {
                    const [existing] = await pool.query(
                        'SELECT id FROM books WHERE google_books_id = ?',
                        [book.googleBooksId]
                    );
                    if (existing.length > 0) {
                        results.skipped.push({ title: book.title, reason: 'Already imported' });
                        continue;
                    }
                }
                
                const bookId = 'gb' + Date.now().toString().slice(-8) + Math.random().toString(36).slice(-3);
                
                await pool.query(`
                    INSERT INTO books (id, title, author, description, image_url, price, stock, page_count, category, google_books_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                `, [
                    bookId,
                    book.title,
                    book.author,
                    book.description || null,
                    book.image_url || null,
                    book.price || book.suggested_price || 199,
                    book.stock || 10,
                    book.page_count || null,
                    book.category || (book.categories && book.categories[0]) || null,
                    book.googleBooksId || null
                ]);
                
                results.success.push({ id: bookId, title: book.title });
            } catch (err) {
                results.failed.push({ title: book.title, error: err.message });
            }
        }
        
        res.json({
            message: `Imported ${results.success.length} books`,
            results
        });
    } catch (err) {
        console.error('Bulk import failed:', err);
        res.status(500).json({ message: 'Bulk import failed' });
    }
});

module.exports = router;
