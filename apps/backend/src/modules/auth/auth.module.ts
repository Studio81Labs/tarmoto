import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/user.entity.js';
import { EmailVerificationToken } from '../../entities/email-verification-token.entity.js';
import { PasswordResetToken } from '../../entities/password-reset-token.entity.js';
import { EmailModule } from '../email/index.js';
import { FeaturesModule } from '../features/features.module.js';
import { AppSettingsModule } from '../app-settings/app-settings.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { OptionalAuthGuard } from './optional-auth.guard.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PasswordResetService } from './password-reset.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      EmailVerificationToken,
      PasswordResetToken,
    ]),
    EmailModule,
    FeaturesModule,
    AppSettingsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('TARMOTO_JWT_SECRET');
        if (!secret && config.get('NODE_ENV') === 'production') {
          throw new Error('TARMOTO_JWT_SECRET must be set in production');
        }
        return {
          secret: secret || 'dev-only-secret-do-not-use-in-production',
          signOptions: { issuer: 'tarmoto' },
        };
      },
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    OptionalAuthGuard,
    EmailVerificationService,
    PasswordResetService,
  ],
  exports: [AuthGuard, OptionalAuthGuard, JwtModule],
})
export class AuthModule {}
