const fs = require("fs");
const { pinggy, TunnelType } = require("@pinggy/pinggy");

async function main() {
  try {
    const tunnel = await pinggy.forward({
      forwarding: [
        {
          address: "localhost:1433",
          type: TunnelType.Tcp,
        },
      ],
      webDebugger: "localhost:4300",
      autoReconnect: true,
    });

    const urls = await tunnel.urls();
    const metadata = {
      urls,
      serverAddress: await tunnel.getServerAddress(),
      status: await tunnel.getStatus(),
      greetMessage: await tunnel.getGreetMessage(),
    };

    fs.writeFileSync("tunnel.txt", JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata));

    // Keep the process alive so the tunnel remains available for Fly.
    setInterval(() => {}, 1 << 30);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

main();
