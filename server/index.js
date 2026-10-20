const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`数学ボードを起動しました: http://localhost:${port}`);
});
