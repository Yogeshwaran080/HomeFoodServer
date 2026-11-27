let app;
let loadError = null;

try {
  app = require('../server');
} catch (err) {
  loadError = {
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : ''
  };
}

module.exports = (req, res) => {
  if (loadError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Server module load failed', ...loadError }));
  }
  try {
    return app(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        error: 'Server request failed',
        message: err && err.message ? err.message : String(err)
      })
    );
  }
};
