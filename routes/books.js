const router = require('express').Router();
const pool = require('../config/database');
const NodeCache = require('node-cache');

// Cache book listings for 60 seconds - public data doesn't change every second
const booksCache = new NodeCache({ stdTTL: 60 });

/**
 * Get all books (with pagination)
 * Optimized: uses window function for single-query count + caching
 */
router.get('/', async (req, res) => {
  try {
    let { page, limit } = req.query;
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 10;
    const offset = (page - 1) * limit;

    const cacheKey = `books_p${page}_l${limit}`;
    const cached = booksCache.get(cacheKey);
    if (cached) return res.json(cached);

    // Single query using window function instead of two separate queries
    const [books] = await pool.query(
      `SELECT id, title, author, category, price, stock, image_url, created_at,
              COUNT(*) OVER() AS total_count
       FROM books
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = books.length > 0 ? parseInt(books[0].total_count) : 0;
    // Remove total_count from individual book objects
    const cleanBooks = books.map(({ total_count, ...book }) => book);

    const result = { page, limit, total, books: cleanBooks };
    booksCache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error("Error fetching books:", err);
    return res.status(500).json({ message: "Server error while fetching books" });
  }
});

/**
 * Search books by title/author (with pagination)
 * Optimized: select only needed columns + single-query count
 */
router.get('/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ message: "Search query is required" });
    }
    let { page, limit } = req.query;
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 10;
    const offset = (page - 1) * limit;

    const cacheKey = `search_${query}_p${page}_l${limit}`;
    const cached = booksCache.get(cacheKey);
    if (cached) return res.json(cached);

    const [books] = await pool.query(
      `SELECT id, title, author, category, price, stock, image_url, created_at,
              COUNT(*) OVER() AS total_count
       FROM books
       WHERE title ILIKE $1 OR author ILIKE $1
       LIMIT $2 OFFSET $3`,
      [`%${query}%`, limit, offset]
    );

    const total = books.length > 0 ? parseInt(books[0].total_count) : 0;
    const cleanBooks = books.map(({ total_count, ...book }) => book);

    const result = { page, limit, total, books: cleanBooks };
    booksCache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error("Error searching books:", err);
    return res.status(500).json({ message: "Server error while searching books" });
  }
});

/**
 * Get single book by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const bookId = req.params.id;
    if (!bookId) {
      return res.status(400).json({ message: "Book ID is required" });
    }

    const cacheKey = `book_${bookId}`;
    const cached = booksCache.get(cacheKey);
    if (cached) return res.json(cached);

    const [books] = await pool.query('SELECT * FROM books WHERE id = $1', [bookId]);
    if (books.length === 0) {
      return res.status(404).json({ message: "Book not found" });
    }

    booksCache.set(cacheKey, books[0]);
    return res.json(books[0]);
  } catch (err) {
    console.error("Error fetching book:", err);
    return res.status(500).json({ message: "Server error while fetching book" });
  }
});

module.exports = router;
