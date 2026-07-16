import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module.js";
import { HealthController } from "./health.controller.js";

describe("apps/ingest AppModule", () => {
  it("compiles and exposes the health probe", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const health = moduleRef.get(HealthController);
    expect(health.getHealth()).toEqual({ status: "ok" });
    await moduleRef.close();
  });
});
