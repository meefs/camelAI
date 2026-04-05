import { createDesktopService } from "../backend/electron-service.ts";

const service = createDesktopService();
const snapshot = service.getSnapshot();
console.log(JSON.stringify(snapshot.runtimeStatus));
service.dispose();
