import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { Challenge } from '../../entities/challenge.entity.js';
import { ChallengeEntry } from '../../entities/challenge-entry.entity.js';
import {
  ChallengeDto,
  ChallengeDetailDto,
  LeaderboardEntryDto,
  JoinChallengeResponseDto,
  ProgressDto,
} from './dto/challenges.dto.js';

@Injectable()
export class ChallengesService {
  constructor(
    @InjectRepository(Challenge)
    private readonly challengeRepo: Repository<Challenge>,
    @InjectRepository(ChallengeEntry)
    private readonly entryRepo: Repository<ChallengeEntry>,
  ) {}

  async listActive(): Promise<ChallengeDto[]> {
    const now = new Date();
    const challenges = await this.challengeRepo.find({
      where: {
        is_active: true,
        starts_at: LessThanOrEqual(now),
        ends_at: MoreThanOrEqual(now),
      },
      order: { ends_at: 'ASC' },
    });

    const counts = await Promise.all(
      challenges.map((c) =>
        this.entryRepo.count({ where: { challenge_id: c.id } }),
      ),
    );

    return challenges.map((c, i) => this.toChallengeDto(c, counts[i]));
  }

  async getDetail(
    challengeId: string,
    userId?: string,
  ): Promise<ChallengeDetailDto> {
    const challenge = await this.challengeRepo.findOne({
      where: { id: challengeId },
    });
    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }

    const [participantCount, leaderboard, myEntry] = await Promise.all([
      this.entryRepo.count({ where: { challenge_id: challengeId } }),
      this.getLeaderboard(challengeId),
      userId
        ? this.entryRepo.findOne({
            where: { challenge_id: challengeId, user_id: userId },
          })
        : null,
    ]);

    return {
      ...this.toChallengeDto(challenge, participantCount),
      my_progress: myEntry?.progress ?? null,
      my_completed: myEntry?.completed ?? null,
      leaderboard,
    };
  }

  async join(
    userId: string,
    challengeId: string,
  ): Promise<JoinChallengeResponseDto> {
    const challenge = await this.challengeRepo.findOne({
      where: { id: challengeId, is_active: true },
    });
    if (!challenge) {
      throw new NotFoundException('Challenge not found');
    }

    const now = new Date();
    if (now < challenge.starts_at || now > challenge.ends_at) {
      throw new BadRequestException('Challenge is not currently active');
    }

    const entry = this.entryRepo.create({
      challenge_id: challengeId,
      user_id: userId,
    });

    let saved: ChallengeEntry;
    try {
      saved = await this.entryRepo.save(entry);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictException('Already joined this challenge');
      }
      throw err;
    }

    return {
      challenge_id: challengeId,
      joined_at: saved.joined_at.toISOString(),
    };
  }

  async getProgress(userId: string, challengeId: string): Promise<ProgressDto> {
    const entry = await this.entryRepo.findOne({
      where: { challenge_id: challengeId, user_id: userId },
      relations: ['challenge'],
    });
    if (!entry) {
      throw new NotFoundException('Not participating in this challenge');
    }

    const target = entry.challenge.target;

    return {
      challenge_id: challengeId,
      progress: entry.progress,
      target,
      completed: entry.completed,
      completed_at: entry.completed_at?.toISOString() ?? null,
      percent:
        target > 0
          ? Math.min(100, Math.round((entry.progress / target) * 100))
          : 0,
    };
  }

  async updateProgress(
    userId: string,
    challengeId: string,
    newProgress: number,
  ): Promise<void> {
    const entry = await this.entryRepo.findOne({
      where: { challenge_id: challengeId, user_id: userId },
      relations: ['challenge'],
    });
    if (!entry) return;

    entry.progress = newProgress;
    if (!entry.completed && newProgress >= entry.challenge.target) {
      entry.completed = true;
      entry.completed_at = new Date();
    }

    await this.entryRepo.save(entry);
  }

  private async getLeaderboard(
    challengeId: string,
  ): Promise<LeaderboardEntryDto[]> {
    const entries = await this.entryRepo.find({
      where: { challenge_id: challengeId },
      relations: ['user'],
      order: { progress: 'DESC', joined_at: 'ASC' },
      take: 20,
    });

    return entries.map((e, i) => ({
      rank: i + 1,
      user_id: e.user_id,
      display_name: e.user?.display_name ?? 'Unknown',
      progress: e.progress,
      completed: e.completed,
    }));
  }

  private toChallengeDto(c: Challenge, participantCount: number): ChallengeDto {
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      metric: c.metric,
      target: c.target,
      starts_at: c.starts_at.toISOString(),
      ends_at: c.ends_at.toISOString(),
      reward_badge_key: c.reward_badge_key,
      participant_count: participantCount,
    };
  }
}
