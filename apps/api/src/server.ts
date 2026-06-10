import { createApiServer } from "./http";
import { loadEnv } from "./config/env";
import { logger } from "./config/logger";

const config = loadEnv();

export const server = createApiServer();

if (process.env.NODE_ENV !== "test") {
  server.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, "ConsistenCy API listening");
  });
}
