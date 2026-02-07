/**
 * DataProxy Server
 *
 * HTTP server for accessing data sources that Cloudflare Workers don't support natively.
 * Currently supports: MS SQL Server
 */
import http from 'node:http';
import sql from 'mssql';

const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // =============================================================================
  // MS SQL Server
  // =============================================================================

  // Query endpoint
  if (req.method === 'POST' && req.url === '/mssql/query') {
    let body = '';

    for await (const chunk of req) {
      body += chunk;
    }

    let connection;
    try {
      const request = JSON.parse(body);

      // Validate required fields
      const { server, user, password, query } = request;
      if (!server || !user || !password || !query) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'Missing required fields: server, user, password, query'
        }));
        return;
      }

      // Build connection config
      const config = {
        server: request.server,
        port: request.port || 1433,
        user: request.user,
        password: request.password,
        database: request.database || 'master',
        options: {
          encrypt: request.encrypt !== false, // Default to encrypted
          trustServerCertificate: request.trustServerCertificate ?? true,
          connectTimeout: request.timeout || 15000,
          requestTimeout: request.timeout || 30000,
        },
        pool: {
          max: 1,
          min: 0,
          idleTimeoutMillis: 1000,
        },
      };

      // Connect
      connection = await sql.connect(config);

      // Execute query with optional parameters
      let result;
      if (request.params && Object.keys(request.params).length > 0) {
        const sqlRequest = connection.request();

        // Add parameters
        for (const [name, value] of Object.entries(request.params)) {
          sqlRequest.input(name, value);
        }

        result = await sqlRequest.query(request.query);
      } else {
        result = await connection.request().query(request.query);
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        recordset: result.recordset,
        recordsets: result.recordsets,
        rowsAffected: result.rowsAffected,
      }));

    } catch (error) {
      const statusCode = error.code === 'ECONNREFUSED' ? 503 : 500;
      res.writeHead(statusCode);
      res.end(JSON.stringify({
        error: error.message,
        code: error.code,
        number: error.number, // SQL Server error number
      }));
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {}
      }
    }
    return;
  }

  // Execute multiple queries in a transaction
  if (req.method === 'POST' && req.url === '/mssql/transaction') {
    let body = '';

    for await (const chunk of req) {
      body += chunk;
    }

    let connection;
    let transaction;
    try {
      const request = JSON.parse(body);

      const { server, user, password, queries } = request;
      if (!server || !user || !password || !queries || !Array.isArray(queries)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'Missing required fields: server, user, password, queries (array)'
        }));
        return;
      }

      const config = {
        server: request.server,
        port: request.port || 1433,
        user: request.user,
        password: request.password,
        database: request.database || 'master',
        options: {
          encrypt: request.encrypt !== false,
          trustServerCertificate: request.trustServerCertificate ?? true,
          connectTimeout: request.timeout || 15000,
          requestTimeout: request.timeout || 30000,
        },
        pool: {
          max: 1,
          min: 0,
          idleTimeoutMillis: 1000,
        },
      };

      connection = await sql.connect(config);
      transaction = new sql.Transaction(connection);
      await transaction.begin();

      const results = [];
      for (const q of queries) {
        const sqlRequest = new sql.Request(transaction);

        if (q.params) {
          for (const [name, value] of Object.entries(q.params)) {
            sqlRequest.input(name, value);
          }
        }

        const result = await sqlRequest.query(q.query);
        results.push({
          recordset: result.recordset,
          rowsAffected: result.rowsAffected,
        });
      }

      await transaction.commit();

      res.writeHead(200);
      res.end(JSON.stringify({ results }));

    } catch (error) {
      if (transaction) {
        try {
          await transaction.rollback();
        } catch {}
      }

      const statusCode = error.code === 'ECONNREFUSED' ? 503 : 500;
      res.writeHead(statusCode);
      res.end(JSON.stringify({
        error: error.message,
        code: error.code,
        number: error.number,
      }));
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch {}
      }
    }
    return;
  }

  // 404 for other routes
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`DataProxy listening on port ${PORT}`);
});
