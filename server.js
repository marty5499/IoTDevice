import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// 提供 public 目錄下的靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 根路徑請求，回傳 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, (err) => {
  if (err) {
    return console.error('啟動伺服器失敗:', err);
  }
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
}); 