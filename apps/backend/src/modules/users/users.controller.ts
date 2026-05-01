import {
  BadRequestException,
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { UsersService } from './users.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import { UpdateContactDto } from './dto/update-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';
import { PublicProfileDto } from './dto/public-profile.dto.js';

@ApiTags('users')
@Controller('users')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  async getProfile(@Req() req: express.Request): Promise<UserResponseDto> {
    return this.usersService.getProfile(req.user!.userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  async updateProfile(
    @Req() req: express.Request,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateProfile(req.user!.userId, dto);
  }

  @Get(':userId/profile')
  @ApiOperation({ summary: "Get a rider's public profile" })
  @ApiResponse({ status: 200, type: PublicProfileDto })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getPublicProfile(
    @Req() req: express.Request,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<PublicProfileDto> {
    return this.usersService.getPublicProfile(req.user!.userId, userId);
  }

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a profile avatar' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, type: UserResponseDto })
  async uploadAvatar(
    @Req() req: express.Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<UserResponseDto> {
    if (!file) {
      throw new BadRequestException('Avatar image is required');
    }

    const publicBaseUrl = `${req.protocol}://${req.get('host')}`;
    return this.usersService.uploadAvatar(
      req.user!.userId,
      file,
      publicBaseUrl,
    );
  }

  @Get('me/contacts')
  @ApiOperation({ summary: 'List emergency contacts' })
  @ApiResponse({ status: 200, type: [ContactResponseDto] })
  async listContacts(
    @Req() req: express.Request,
  ): Promise<ContactResponseDto[]> {
    return this.usersService.listContacts(req.user!.userId);
  }

  @Post('me/contacts')
  @ApiOperation({ summary: 'Add emergency contact' })
  @ApiResponse({ status: 201, type: ContactResponseDto })
  async addContact(
    @Req() req: express.Request,
    @Body() dto: CreateContactDto,
  ): Promise<ContactResponseDto> {
    return this.usersService.addContact(req.user!.userId, dto);
  }

  @Patch('me/contacts/:contactId')
  @ApiOperation({ summary: 'Update emergency contact' })
  @ApiResponse({ status: 200, type: ContactResponseDto })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async updateContact(
    @Req() req: express.Request,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateContactDto,
  ): Promise<ContactResponseDto> {
    return this.usersService.updateContact(req.user!.userId, contactId, dto);
  }

  @Delete('me/contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete emergency contact' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async deleteContact(
    @Req() req: express.Request,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    return this.usersService.deleteContact(req.user!.userId, contactId);
  }
}
