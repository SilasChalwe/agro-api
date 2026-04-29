const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json());
app.use(require('cors')());

// ✅ THIS LINE IS THE MISSING PIECE
app.use(express.static(path.join(__dirname)));

// Save farm boundary
app.post('/farms', (req, res) => {
  let farms = [];

  if (fs.existsSync('farms.json')) {
    farms = JSON.parse(fs.readFileSync('farms.json'));
  }

  farms.push(req.body);
  fs.writeFileSync('farms.json', JSON.stringify(farms, null, 2));

  res.json({ message: 'Farm saved' });
});

// Get all farms
app.get('/farms', (req, res) => {
  if (!fs.existsSync('farms.json')) return res.json([]);
  res.json(JSON.parse(fs.readFileSync('farms.json')));
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
