require("dotenv").config();

const { createApp } = require("./src/app");

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
