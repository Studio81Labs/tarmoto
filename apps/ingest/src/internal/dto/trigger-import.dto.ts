import { IsIn, IsOptional, IsString } from "class-validator";

/**
 * Body of `POST /internal/poi/import` — the backend admin proxy's manual
 * trigger. `trigger` defaults to `manual` (the proxy is the only caller).
 */
export class TriggerImportRequestDto {
  @IsString()
  source!: string;

  @IsString()
  code!: string;

  @IsOptional()
  @IsIn(["manual", "cron"])
  trigger?: "manual" | "cron";
}
