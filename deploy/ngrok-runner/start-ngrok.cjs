const fs = require("fs");
const ngrok = require("@ngrok/ngrok");

async function main() {
  try {
    const listener = await ngrok.forward({
      proto: "tcp",
      addr: 1433,
      authtoken: process.env.NGROK_AUTHTOKEN,
    });

    const url = listener.url();
    fs.writeFileSync("tunnel.txt", url);
    console.log(url);

    // Keep the process alive so Fly can continue reaching the local SQL Server.
    setInterval(() => {}, 1 << 30);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

main();
