-- Enable UUID (optional but useful)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ================================
-- USERS
-- ================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255),
    phone VARCHAR(20),
    bio TEXT,
    profile_pic VARCHAR(512),
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ================================
-- BOOKS
-- ================================
CREATE TABLE books (
    id VARCHAR(20) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    stock INT NOT NULL,
    description TEXT,
    cover VARCHAR(255),
    image_url VARCHAR(255),
    content_url VARCHAR(512),
    sample_url VARCHAR(512),
    content_type VARCHAR(10) DEFAULT 'pdf',
    page_count INT DEFAULT 0,
    category VARCHAR(100),
    google_books_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ================================
-- ADDRESSES
-- ================================
CREATE TABLE addresses (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    label VARCHAR(50),
    recipient VARCHAR(255),
    street VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    zip VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ================================
-- ORDERS
-- ================================
CREATE TYPE order_mode AS ENUM ('buy','rent','gift');
CREATE TYPE payment_status_enum AS ENUM ('pending','completed','failed','captured');

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    mode order_mode NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    total DECIMAL(10,2) NOT NULL,
    shipping_address_id INT,
    payment_method VARCHAR(50),
    notes TEXT,
    rental_duration INT,
    rental_end TIMESTAMP,
    delivery_eta TIMESTAMP,
    gift_email VARCHAR(255),
    shipping_speed VARCHAR(50),
    shipping_fee DECIMAL(10,2),
    cod_fee DECIMAL(10,2),
    payment_status payment_status_enum DEFAULT 'pending',
    razorpay_order_id VARCHAR(100),
    razorpay_payment_id VARCHAR(100),
    razorpay_signature VARCHAR(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (shipping_address_id) REFERENCES addresses(id) ON DELETE SET NULL
);

-- ================================
-- ORDER ITEMS
-- ================================
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    book_id VARCHAR(20) NOT NULL,
    quantity INT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT
);

-- ================================
-- GIFTS
-- ================================
CREATE TABLE gifts (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    book_id VARCHAR(20) NOT NULL,
    quantity INT DEFAULT 1,
    recipient_email VARCHAR(255) NOT NULL,
    claim_token VARCHAR(64) UNIQUE NOT NULL,
    recipient_user_id INT,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ================================
-- WISHLIST
-- ================================
CREATE TABLE wishlist (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    book_id VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- ================================
-- REVIEWS
-- ================================
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    book_id VARCHAR(20) NOT NULL,
    rating SMALLINT NOT NULL,
    review_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- ================================
-- READING PROGRESS
-- ================================
CREATE TABLE reading_progress (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    book_id VARCHAR(20) NOT NULL,
    current_page INT DEFAULT 1,
    total_pages INT DEFAULT 1,
    progress_percent DECIMAL(5,2) DEFAULT 0.00,
    last_read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- ================================
-- INDEXES (Performance)
-- ================================

-- Books: search, listing, filtering
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_category ON books(LOWER(category));
CREATE INDEX IF NOT EXISTS idx_books_stock ON books(stock);
CREATE INDEX IF NOT EXISTS idx_books_created_at ON books(created_at DESC);

-- Orders: user lookup, payment status filtering
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_date ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);

-- Order items: JOIN performance for recommendations and library
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_book_id ON order_items(book_id);

-- Reviews: book rating lookups
CREATE INDEX IF NOT EXISTS idx_reviews_book_id ON reviews(book_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_book ON reviews(user_id, book_id);

-- Users: auth middleware lookup
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Wishlist & gifts
CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON wishlist(user_id);
CREATE INDEX IF NOT EXISTS idx_gifts_recipient_user ON gifts(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_gifts_claim_token ON gifts(claim_token);

-- Reading progress
CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);

-- ================================
-- VIEW
-- ================================
CREATE VIEW user_orders_details AS
SELECT
    u.id AS user_id,
    u.name AS user_name,
    o.id AS order_id,
    o.mode,
    o.payment_method,
    o.shipping_speed,
    o.status,
    o.created_at,
    o.gift_email,
    oi.book_id,
    b.title AS book_title,
    oi.quantity,
    oi.price,
    (oi.quantity * oi.price) AS line_total
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN order_items oi ON oi.order_id = o.id
JOIN books b ON b.id = oi.book_id;
