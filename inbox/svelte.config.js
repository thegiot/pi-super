import adapter from "@sveltejs/adapter-static";

/** The build lands beside the server's other static output, served by server.ts at /inbox. */
const config = {
	kit: {
		adapter: adapter({ pages: "../dist/inbox", assets: "../dist/inbox", fallback: "index.html", strict: true }),
		paths: { base: "/inbox" },
	},
};

export default config;
