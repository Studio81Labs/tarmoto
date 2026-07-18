import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FEATURE_DEFINITIONS,
  SYSTEM_FEATURE_KEYS,
  isSystemFeatureKey,
  resolveSystemSwitch,
  type SystemFeatureKey,
} from '@tarmoto/shared';
import { FeatureState } from '../../entities/feature-state.entity.js';
import {
  AdminSystemSwitchDto,
  AdminSystemSwitchesResponseDto,
  SetSystemSwitchDisabledDto,
} from './dto/admin-system-switches.dto.js';

/**
 * Operator management for system switches (kill toggles, default ON). The
 * switch set is code-defined; operators only disable (write a `force_off`
 * row to the shared `feature_states` table) or enable (clear it). No tier,
 * no per-user layer.
 */
@Injectable()
export class AdminSystemSwitchesService {
  constructor(
    @InjectRepository(FeatureState)
    private readonly featureStates: Repository<FeatureState>,
  ) {}

  async listSwitches(): Promise<AdminSystemSwitchesResponseDto> {
    const rows = await this.featureStates.find();
    const byFeature = new Map(rows.map((r) => [r.feature, r]));
    const switches = SYSTEM_FEATURE_KEYS.map((key): AdminSystemSwitchDto => {
      const def = FEATURE_DEFINITIONS[key];
      const row = byFeature.get(key);
      const disabled = row?.state === 'force_off';
      return {
        key,
        description: def.description,
        enabled: resolveSystemSwitch(key, row?.state),
        disabled_reason: disabled ? row.reason : null,
        disabled_by: disabled ? row.updated_by : null,
        disabled_at: disabled ? row.updated_at.toISOString() : null,
      };
    });
    return { switches };
  }

  async disableSwitch(
    key: string,
    dto: SetSystemSwitchDisabledDto,
    adminUserId: string,
  ): Promise<AdminSystemSwitchDto> {
    const switchKey = this.assertKnownSwitch(key);
    const existing = await this.featureStates.findOne({
      where: { feature: switchKey },
    });
    const row = existing ?? this.featureStates.create({ feature: switchKey });
    row.state = 'force_off';
    row.reason = dto.reason;
    row.updated_by = adminUserId;
    await this.featureStates.save(row);
    return this.switchDto(switchKey);
  }

  /** Clearing an absent override is a no-op — the call is idempotent. */
  async enableSwitch(key: string): Promise<void> {
    const switchKey = this.assertKnownSwitch(key);
    await this.featureStates.delete({ feature: switchKey });
  }

  private async switchDto(
    key: SystemFeatureKey,
  ): Promise<AdminSystemSwitchDto> {
    const { switches } = await this.listSwitches();
    const found = switches.find((s) => s.key === key);
    if (!found) throw new NotFoundException('System switch not found');
    return found;
  }

  private assertKnownSwitch(key: string): SystemFeatureKey {
    if (!isSystemFeatureKey(key)) {
      throw new BadRequestException(`Unknown system switch: ${key}`);
    }
    return key;
  }
}
