import {
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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { UsersService } from './users.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { CreateContactDto } from './dto/create-contact.dto.js';
import {
  UserResponseDto,
  ContactResponseDto,
} from './dto/user-response.dto.js';

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
