// mssql-backed database layer
const fs = require("fs");
const path = require("path");
const sql = require("mssql");

const DB_SERVER = process.env.DB_SERVER || "localhost";
const DB_NAME = process.env.DB_NAME || "ZaneeStore";
const DB_USER = process.env.DB_USER || "sa";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433;
const DB_INSTANCE = process.env.DB_INSTANCE || "";
const DB_ENCRYPT = typeof process.env.DB_ENCRYPT !== "undefined" ? String(process.env.DB_ENCRYPT) === "true" : false;
const DB_TRUST_CERT = typeof process.env.DB_TRUST_CERT !== "undefined" ? String(process.env.DB_TRUST_CERT) === "true" : true;
const DB_AUTO_SEED = typeof process.env.DB_AUTO_SEED !== "undefined" ? String(process.env.DB_AUTO_SEED) !== "false" : true;

const STORE_DATA_FILE = path.resolve(__dirname, "../data/store.json");
const USERS_DATA_FILE = path.resolve(__dirname, "../data/users.json");

function loadSeedFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Unable to load seed file ${path.basename(filePath)}:`, error && error.message ? error.message : error);
    return fallbackValue;
  }
}

const storeSeedData = loadSeedFile(STORE_DATA_FILE, { categories: [], products: [], favorites: [], cartItems: [], orders: [] });
const usersSeedData = loadSeedFile(USERS_DATA_FILE, []);

const config = {
  server: DB_SERVER,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  options: {
    encrypt: DB_ENCRYPT,
    trustServerCertificate: DB_TRUST_CERT,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

if (DB_INSTANCE) {
  config.options.instanceName = DB_INSTANCE;
} else {
  config.port = DB_PORT;
}

let poolPromise = null;

async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = await sql.connect(config);
  return poolPromise;
}

async function ensureSchema(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.Categories', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Categories (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(100) NOT NULL UNIQUE
      );
    END;

    IF OBJECT_ID('dbo.Products', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Products (
        Id NVARCHAR(100) NOT NULL PRIMARY KEY,
        Sku NVARCHAR(100) NOT NULL UNIQUE,
        Name NVARCHAR(255) NOT NULL,
        CategoryId INT NOT NULL,
        Price BIGINT NOT NULL,
        WarrantyMonths INT NOT NULL CONSTRAINT DF_Products_WarrantyMonths DEFAULT 0,
        Stock INT NOT NULL CONSTRAINT DF_Products_Stock DEFAULT 0,
        Image NVARCHAR(MAX) NULL,
        Specs NVARCHAR(MAX) NULL,
        Description NVARCHAR(MAX) NULL,
        CONSTRAINT FK_Products_Categories FOREIGN KEY (CategoryId) REFERENCES dbo.Categories(Id)
      );
    END;

    IF OBJECT_ID('dbo.Users', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Users (
        Id NVARCHAR(100) NOT NULL PRIMARY KEY,
        Username NVARCHAR(100) NOT NULL UNIQUE,
        Email NVARCHAR(255) NOT NULL UNIQUE,
        Phone NVARCHAR(50) NOT NULL UNIQUE,
        PasswordHash NVARCHAR(255) NOT NULL,
        Role NVARCHAR(50) NOT NULL,
        IsLocked BIT NOT NULL CONSTRAINT DF_Users_IsLocked DEFAULT 0,
        CreatedAt DATETIME2 NOT NULL
      );
    END;

    IF OBJECT_ID('dbo.Favorites', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Favorites (
        UserId NVARCHAR(100) NOT NULL,
        ProductId NVARCHAR(100) NOT NULL,
        CONSTRAINT PK_Favorites PRIMARY KEY (UserId, ProductId),
        CONSTRAINT FK_Favorites_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id),
        CONSTRAINT FK_Favorites_Products FOREIGN KEY (ProductId) REFERENCES dbo.Products(Id)
      );
    END;

    IF OBJECT_ID('dbo.CartItems', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.CartItems (
        UserId NVARCHAR(100) NOT NULL,
        ProductId NVARCHAR(100) NOT NULL,
        Quantity INT NOT NULL,
        CONSTRAINT PK_CartItems PRIMARY KEY (UserId, ProductId),
        CONSTRAINT FK_CartItems_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id),
        CONSTRAINT FK_CartItems_Products FOREIGN KEY (ProductId) REFERENCES dbo.Products(Id)
      );
    END;

    IF OBJECT_ID('dbo.Orders', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.Orders (
        Id NVARCHAR(100) NOT NULL PRIMARY KEY,
        UserId NVARCHAR(100) NOT NULL,
        Username NVARCHAR(100) NOT NULL,
        Subtotal BIGINT NOT NULL,
        ShippingFee BIGINT NOT NULL,
        Total BIGINT NOT NULL,
        FulfillmentMethod NVARCHAR(100) NOT NULL,
        PickupDate DATETIME2 NULL,
        Address NVARCHAR(MAX) NULL,
        PaymentMethod NVARCHAR(100) NOT NULL,
        PaymentStatus NVARCHAR(100) NOT NULL,
        Status NVARCHAR(255) NOT NULL,
        CreatedAt DATETIME2 NOT NULL,
        CONSTRAINT FK_Orders_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id)
      );
    END;

    IF OBJECT_ID('dbo.OrderItems', 'U') IS NULL
    BEGIN
      CREATE TABLE dbo.OrderItems (
        OrderId NVARCHAR(100) NOT NULL,
        ProductId NVARCHAR(100) NOT NULL,
        Quantity INT NOT NULL,
        UnitPrice BIGINT NOT NULL,
        Subtotal BIGINT NOT NULL,
        CONSTRAINT PK_OrderItems PRIMARY KEY (OrderId, ProductId),
        CONSTRAINT FK_OrderItems_Orders FOREIGN KEY (OrderId) REFERENCES dbo.Orders(Id),
        CONSTRAINT FK_OrderItems_Products FOREIGN KEY (ProductId) REFERENCES dbo.Products(Id)
      );
    END;
  `);
}

async function getDatabaseCounts(pool) {
  const result = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.Categories) AS categoryCount,
      (SELECT COUNT(*) FROM dbo.Products) AS productCount,
      (SELECT COUNT(*) FROM dbo.Users) AS userCount,
      (SELECT COUNT(*) FROM dbo.Orders) AS orderCount
  `);
  return result.recordset[0] || { categoryCount: 0, productCount: 0, userCount: 0, orderCount: 0 };
}

async function loadCategoryMap(pool) {
  const result = await pool.request().query("SELECT Id, Name FROM dbo.Categories");
  return new Map(result.recordset.map((row) => [row.Name, row.Id]));
}

async function ensureCategory(pool, categoryMap, categoryName) {
  if (categoryMap.has(categoryName)) {
    return categoryMap.get(categoryName);
  }

  await pool.request().input("name", sql.NVarChar, categoryName).query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = @name)
    BEGIN
      INSERT INTO dbo.Categories (Name) VALUES (@name)
    END
  `);

  const refreshedMap = await loadCategoryMap(pool);
  for (const [name, id] of refreshedMap.entries()) {
    categoryMap.set(name, id);
  }
  return categoryMap.get(categoryName);
}

async function seedCategories(pool) {
  const categories = Array.isArray(storeSeedData.categories) ? storeSeedData.categories : [];
  for (const categoryName of categories) {
    await pool.request().input("name", sql.NVarChar, categoryName).query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.Categories WHERE Name = @name)
      BEGIN
        INSERT INTO dbo.Categories (Name) VALUES (@name)
      END
    `);
  }
}

async function seedProducts(pool) {
  const products = Array.isArray(storeSeedData.products) ? storeSeedData.products : [];
  const categoryMap = await loadCategoryMap(pool);

  for (const product of products) {
    const categoryId = await ensureCategory(pool, categoryMap, product.category || "Khac");
    await pool
      .request()
      .input("id", sql.NVarChar, product.id)
      .input("sku", sql.NVarChar, product.sku || product.id)
      .input("name", sql.NVarChar, product.name || "Unnamed product")
      .input("categoryId", sql.Int, categoryId)
      .input("price", sql.BigInt, Number(product.price || 0))
      .input("warrantyMonths", sql.Int, Number(product.warrantyMonths || 0))
      .input("stock", sql.Int, Number(product.stock || 0))
      .input("image", sql.NVarChar(sql.MAX), product.image || "")
      .input("specs", sql.NVarChar(sql.MAX), JSON.stringify(Array.isArray(product.specs) ? product.specs : []))
      .input("description", sql.NVarChar(sql.MAX), product.description || "")
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.Products WHERE Id = @id)
        BEGIN
          INSERT INTO dbo.Products (Id, Sku, Name, CategoryId, Price, WarrantyMonths, Stock, Image, Specs, Description)
          VALUES (@id, @sku, @name, @categoryId, @price, @warrantyMonths, @stock, @image, @specs, @description)
        END
      `);
  }
}

async function seedUsers(pool) {
  const users = Array.isArray(usersSeedData) ? usersSeedData : [];
  for (const user of users) {
    await pool
      .request()
      .input("id", sql.NVarChar, user.id)
      .input("username", sql.NVarChar, user.username)
      .input("email", sql.NVarChar, user.email)
      .input("phone", sql.NVarChar, user.phone)
      .input("passwordHash", sql.NVarChar, user.passwordHash)
      .input("role", sql.NVarChar, user.role || "user")
      .input("isLocked", sql.Bit, !!user.isLocked)
      .input("createdAt", sql.DateTime2, new Date(user.createdAt || Date.now()))
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Id = @id)
        BEGIN
          INSERT INTO dbo.Users (Id, Username, Email, Phone, PasswordHash, Role, IsLocked, CreatedAt)
          VALUES (@id, @username, @email, @phone, @passwordHash, @role, @isLocked, @createdAt)
        END
      `);
  }
}

async function seedOrders(pool) {
  const orders = Array.isArray(storeSeedData.orders) ? storeSeedData.orders : [];
  for (const order of orders) {
    await pool
      .request()
      .input("id", sql.NVarChar, order.id)
      .input("userId", sql.NVarChar, order.userId)
      .input("username", sql.NVarChar, order.username)
      .input("subtotal", sql.BigInt, Number(order.subtotal || 0))
      .input("shippingFee", sql.BigInt, Number(order.shippingFee || 0))
      .input("total", sql.BigInt, Number(order.total || 0))
      .input("fulfillmentMethod", sql.NVarChar, order.fulfillmentMethod || "pickup")
      .input("pickupDate", sql.DateTime2, order.pickupDate ? new Date(order.pickupDate) : null)
      .input("address", sql.NVarChar(sql.MAX), order.address || "")
      .input("paymentMethod", sql.NVarChar, order.paymentMethod || "pickup")
      .input("paymentStatus", sql.NVarChar, order.paymentStatus || "pending-cod")
      .input("status", sql.NVarChar, order.status || "Pending")
      .input("createdAt", sql.DateTime2, new Date(order.createdAt || Date.now()))
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.Orders WHERE Id = @id)
        BEGIN
          INSERT INTO dbo.Orders
          (Id, UserId, Username, Subtotal, ShippingFee, Total, FulfillmentMethod, PickupDate, Address, PaymentMethod, PaymentStatus, Status, CreatedAt)
          VALUES
          (@id, @userId, @username, @subtotal, @shippingFee, @total, @fulfillmentMethod, @pickupDate, @address, @paymentMethod, @paymentStatus, @status, @createdAt)
        END
      `);

    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items) {
      await pool
        .request()
        .input("orderId", sql.NVarChar, order.id)
        .input("productId", sql.NVarChar, item.productId)
        .input("quantity", sql.Int, Number(item.quantity || 1))
        .input("unitPrice", sql.BigInt, Number(item.unitPrice || 0))
        .input("subtotal", sql.BigInt, Number(item.subtotal || 0))
        .query(`
          IF NOT EXISTS (SELECT 1 FROM dbo.OrderItems WHERE OrderId = @orderId AND ProductId = @productId)
          BEGIN
            INSERT INTO dbo.OrderItems (OrderId, ProductId, Quantity, UnitPrice, Subtotal)
            VALUES (@orderId, @productId, @quantity, @unitPrice, @subtotal)
          END
        `);
    }
  }
}

async function seedDatabase(pool) {
  if (!DB_AUTO_SEED) {
    return;
  }

  const counts = await getDatabaseCounts(pool);
  const shouldSeedCatalog = Number(counts.categoryCount || 0) === 0 || Number(counts.productCount || 0) === 0;
  const shouldSeedUsers = Number(counts.userCount || 0) === 0;
  const shouldSeedOrders = Number(counts.orderCount || 0) === 0;

  if (shouldSeedCatalog) {
    await seedCategories(pool);
    await seedProducts(pool);
  }

  if (shouldSeedUsers) {
    await seedUsers(pool);
  }

  if (shouldSeedOrders) {
    await seedOrders(pool);
  }

  if (shouldSeedCatalog || shouldSeedUsers || shouldSeedOrders) {
    const nextCounts = await getDatabaseCounts(pool);
    console.log(
      `Database seed complete: ${nextCounts.categoryCount} categories, ${nextCounts.productCount} products, ${nextCounts.userCount} users, ${nextCounts.orderCount} orders`
    );
  }
}

async function initializeDatabase() {
  try {
    const pool = await getPool();
    await ensureSchema(pool);
    await seedDatabase(pool);
    await pool.request().query("SELECT 1 AS ok");
    console.log(`Connected SQL Server DB: ${DB_NAME} @ ${DB_SERVER}${DB_INSTANCE ? `\\${DB_INSTANCE}` : `:${DB_PORT}`}`);
  } catch (err) {
    console.error("Failed to connect to SQL Server:", err && err.message ? err.message : err);
    throw err;
  }
}

function parseProduct(row) {
  if (!row) return null;
  let specs = [];
  if (row.Specs) {
    if (Array.isArray(row.Specs)) specs = row.Specs;
    else if (typeof row.Specs === "string") {
      try {
        specs = JSON.parse(row.Specs);
      } catch (_) {
        specs = String(row.Specs).split("||").map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  return {
    id: row.Id || row.id || "",
    sku: row.Sku || row.sku || "",
    name: row.Name || row.name || "",
    image: row.Image || row.image || "",
    price: Number(row.Price || row.price || 0),
    category: row.CategoryName || row.Category || row.category || "",
    specs,
    description: row.Description || row.description || "",
    warrantyMonths: row.WarrantyMonths || row.warrantyMonths || 0,
    stock: row.Stock || row.stock || 0,
  };
}

function parseUser(row) {
  if (!row) return null;
  return {
    id: row.Id || row.id || "",
    username: row.Username || row.username || row.Name || "",
    email: row.Email || row.email || "",
    phone: row.Phone || row.phone || "",
    passwordHash: row.PasswordHash || row.passwordHash || "",
    role: row.Role || row.role || "user",
    isLocked: !!row.IsLocked || !!row.isLocked,
    createdAt: row.CreatedAt || row.createdAt,
  };
}

module.exports = { sql, getPool, initializeDatabase, parseProduct, parseUser };
