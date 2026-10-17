/**
 * Seed a small but realistic e-commerce SQLite database for the data-copilot demo.
 * Deterministic (fixed PRNG seed) so results are reproducible.
 *
 * Output: <dir>/demo.db
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, "demo.db");
mkdirSync(here, { recursive: true });
rmSync(dbPath, { force: true });

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rnd = mulberry32(20261016);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT NOT NULL,
  segment     TEXT NOT NULL CHECK (segment IN ('new','returning','vip')),
  signup_date TEXT NOT NULL
);
CREATE TABLE products (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status      TEXT NOT NULL CHECK (status IN ('paid','refunded','cancelled')),
  created_at  TEXT NOT NULL
);
CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE refunds (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_items_product ON order_items(product_id);
`);

const countries = ["US", "DE", "JP", "BR", "IN", "GB", "FR", "CA"];
const segments = ["new", "returning", "vip"];
const categories = ["Electronics", "Home", "Outdoor", "Books", "Toys", "Grocery"];
const productWords = {
	Electronics: ["Earbuds", "Monitor", "Keyboard", "Charger", "Speaker"],
	Home: ["Lamp", "Blender", "Chair", "Mug", "Blanket"],
	Outdoor: ["Tent", "Backpack", "Bottle", "Lantern", "Boots"],
	Books: ["Novel", "Cookbook", "Atlas", "Manual", "Anthology"],
	Toys: ["Blocks", "Puzzle", "Robot", "Kite", "Doll"],
	Grocery: ["Coffee", "Tea", "Olive Oil", "Honey", "Pasta"],
};

const insertCustomer = db.prepare("INSERT INTO customers (id,name,country,segment,signup_date) VALUES (?,?,?,?,?)");
const insertProduct = db.prepare("INSERT INTO products (id,name,category,unit_price_cents) VALUES (?,?,?,?)");
const insertOrder = db.prepare("INSERT INTO orders (id,customer_id,status,created_at) VALUES (?,?,?,?)");
const insertItem = db.prepare("INSERT INTO order_items (id,order_id,product_id,quantity,unit_price_cents) VALUES (?,?,?,?,?)");
const insertRefund = db.prepare("INSERT INTO refunds (id,order_id,amount_cents,reason,created_at) VALUES (?,?,?,?,?)");

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// customers
const CUSTOMERS = 300;
for (let i = 1; i <= CUSTOMERS; i++) {
	insertCustomer.run(i, `Customer ${String(i).padStart(3, "0")}`, pick(countries), pick(segments), iso(NOW - int(1, 700) * DAY));
}

// products
const PRODUCTS = 24;
let pid = 0;
const productRows = [];
for (const category of categories) {
	for (const word of productWords[category]) {
		pid++;
		const price = int(5, 300) * 100 + pick([0, 49, 99]);
		productRows.push({ id: pid, category, price });
		insertProduct.run(pid, `${category} ${word}`, category, price);
	}
	if (pid >= PRODUCTS) break;
}

// orders + items (paid/refunded/cancelled)
const ORDERS = 1200;
let itemId = 0;
let refundId = 0;
for (let o = 1; o <= ORDERS; o++) {
	const customerId = int(1, CUSTOMERS);
	const daysAgo = int(0, 119);
	const createdAt = NOW - daysAgo * DAY - int(0, 23) * 3600000;
	const roll = rnd();
	const status = roll < 0.06 ? "cancelled" : roll < 0.16 ? "refunded" : "paid";
	insertOrder.run(o, customerId, status, iso(createdAt));

	let orderTotal = 0;
	const lines = int(1, 4);
	for (let l = 0; l < lines; l++) {
		const product = pick(productRows);
		const qty = int(1, 3);
		itemId++;
		insertItem.run(itemId, o, product.id, qty, product.price);
		orderTotal += qty * product.price;
	}
	if (status === "refunded") {
		refundId++;
		insertRefund.run(refundId, o, orderTotal, pick(["damaged", "late", "wrong item", "changed mind"]), iso(createdAt + int(1, 20) * DAY));
	}
}

const summary = {
	db: dbPath,
	customers: db.prepare("select count(*) n from customers").get().n,
	products: db.prepare("select count(*) n from products").get().n,
	orders: db.prepare("select count(*) n from orders").get().n,
	order_items: db.prepare("select count(*) n from order_items").get().n,
	refunds: db.prepare("select count(*) n from refunds").get().n,
};
db.close();
console.log(JSON.stringify(summary, null, 2));
