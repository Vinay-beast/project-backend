-- Create database
CREATE DATABASE IF NOT EXISTS booknook;
USE booknook;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    bio TEXT,
    profile_pic VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Books table
CREATE TABLE IF NOT EXISTS books (
    id VARCHAR(10) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock INT NOT NULL,
    description TEXT,
    cover VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Addresses table
CREATE TABLE IF NOT EXISTS addresses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    label VARCHAR(50) NOT NULL,
    recipient VARCHAR(255) NOT NULL,
    street VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    zip VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Payment cards table
CREATE TABLE IF NOT EXISTS payment_cards (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    card_name VARCHAR(255) NOT NULL,
    card_number VARCHAR(255) NOT NULL,
    expiry VARCHAR(7) NOT NULL,
    cvv VARCHAR(4) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    mode ENUM('buy', 'rent', 'gift') NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    total DECIMAL(10, 2) NOT NULL,
    shipping_address_id INT,
    payment_method VARCHAR(50),
    notes TEXT,
    rental_duration INT,
    gift_email VARCHAR(255),
    shipping_speed VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (shipping_address_id) REFERENCES addresses(id)
);

-- Order items table
CREATE TABLE IF NOT EXISTS order_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT NOT NULL,
    book_id VARCHAR(10) NOT NULL,
    quantity INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id)
);

-- Insert sample books
INSERT INTO books (id, title, author, price, stock, description, cover) VALUES
('b1', 'The Pragmatic Programmer', 'Andrew Hunt', 599.00, 8, 'Timeless tips for pragmatic software development.', 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f'),
('b2', 'Clean Code', 'Robert C. Martin', 549.00, 12, 'Principles of writing clean, maintainable software.', 'https://images.unsplash.com/photo-1516979187457-637abb4f9353'),
('b3', 'Atomic Habits', 'James Clear', 399.00, 20, 'A framework for improving every day.', 'https://images.unsplash.com/photo-1544937950-fa07a98d237f'),
('b4', 'Thinking, Fast and Slow', 'Daniel Kahneman', 449.00, 9, 'Insights into how we think.', 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e'),
('b5', 'Sapiens', 'Yuval Noah Harari', 499.00, 7, 'A brief history of humankind.', 'https://images.unsplash.com/photo-1526318472351-c75fcf070305'),
('b6', 'Ikigai', 'Héctor García', 299.00, 15, 'Discover your reason for being.', 'https://images.unsplash.com/photo-1507842217343-583bb7270b66');
