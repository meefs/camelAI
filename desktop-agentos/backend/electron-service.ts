import { DesktopService } from "./service";

export { DesktopService };

export function createDesktopService(): DesktopService {
  return new DesktopService();
}
