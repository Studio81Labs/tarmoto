import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import * as express from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import { TripCollabService } from './trip-collab.service.js';
import { CreateSuggestionDto } from './dto/create-suggestion.dto.js';
import { SuggestionDto } from './dto/suggestion-response.dto.js';
import { VoteSuggestionDto } from './dto/vote-suggestion.dto.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { ListMessagesDto } from './dto/list-messages.dto.js';
import { MessageDto } from './dto/message-response.dto.js';

@ApiTags('trips')
@Controller('trips/:tripId')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TripCollabController {
  constructor(private readonly collab: TripCollabService) {}

  // ── Suggestions ─────────────────────────────────────────────────

  @Get('suggestions')
  @ApiOperation({
    summary: 'List route/segment suggestions for a trip',
    description:
      'Members-only. Returns every suggestion with aggregated vote ' +
      "counts and the caller's own vote, so the planner map can render " +
      'markers and priority without a follow-up request.',
  })
  @ApiResponse({ status: 200, type: [SuggestionDto] })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async listSuggestions(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ): Promise<SuggestionDto[]> {
    return this.collab.listSuggestions(req.user!.userId, tripId);
  }

  @Post('suggestions')
  @ApiOperation({ summary: 'Suggest a route change or road segment' })
  @ApiResponse({ status: 201, type: SuggestionDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async createSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: CreateSuggestionDto,
  ): Promise<SuggestionDto> {
    return this.collab.createSuggestion(req.user!.userId, tripId, dto);
  }

  @Delete('suggestions/:suggestionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a suggestion',
    description:
      'Authors can always delete their own; the trip owner can ' +
      'delete any suggestion.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Cannot delete this suggestion' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async deleteSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
  ): Promise<void> {
    await this.collab.deleteSuggestion(req.user!.userId, tripId, suggestionId);
  }

  @Post('suggestions/:suggestionId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a suggestion (owner only)',
    description:
      'Marks the suggestion as `accepted`. Only the trip owner may ' +
      'resolve — authors can only delete their own. Re-accepting an ' +
      'already-resolved row returns 400.',
  })
  @ApiResponse({ status: 200, type: SuggestionDto })
  @ApiResponse({ status: 403, description: 'Not the trip owner' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async acceptSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
  ): Promise<SuggestionDto> {
    return this.collab.resolveSuggestion(
      req.user!.userId,
      tripId,
      suggestionId,
      'accepted',
    );
  }

  @Post('suggestions/:suggestionId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a suggestion (owner only)',
  })
  @ApiResponse({ status: 200, type: SuggestionDto })
  @ApiResponse({ status: 403, description: 'Not the trip owner' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async rejectSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
  ): Promise<SuggestionDto> {
    return this.collab.resolveSuggestion(
      req.user!.userId,
      tripId,
      suggestionId,
      'rejected',
    );
  }

  @Post('suggestions/:suggestionId/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen a resolved suggestion (owner only)',
    description:
      'Flips an `accepted`/`rejected` suggestion back to `open` so the ' +
      'group can keep voting and the owner can re-decide. Reopening an ' +
      'already-open row returns 400.',
  })
  @ApiResponse({ status: 200, type: SuggestionDto })
  @ApiResponse({ status: 403, description: 'Not the trip owner' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async reopenSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
  ): Promise<SuggestionDto> {
    return this.collab.reopenSuggestion(req.user!.userId, tripId, suggestionId);
  }

  @Post('suggestions/:suggestionId/vote')
  @ApiOperation({
    summary: 'Cast or change a vote on a suggestion',
    description:
      'Idempotent with respect to (suggestion, user): calling with the ' +
      'same vote value is a no-op; with the opposite value flips the vote.',
  })
  @ApiResponse({ status: 200, type: SuggestionDto })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async voteSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Body() dto: VoteSuggestionDto,
  ): Promise<SuggestionDto> {
    return this.collab.voteSuggestion(
      req.user!.userId,
      tripId,
      suggestionId,
      dto.vote,
    );
  }

  @Delete('suggestions/:suggestionId/vote')
  @ApiOperation({ summary: "Remove the caller's vote on a suggestion" })
  @ApiResponse({ status: 200, type: SuggestionDto })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async unvoteSuggestion(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
  ): Promise<SuggestionDto> {
    return this.collab.unvoteSuggestion(req.user!.userId, tripId, suggestionId);
  }

  // ── Chat ────────────────────────────────────────────────────────

  @Get('messages')
  @ApiOperation({
    summary: 'List trip chat messages (newest first)',
    description:
      'Keyset-paginated on `created_at`. Pass the oldest ' +
      '`created_at` from the previous page as `before` to load older ' +
      'messages.',
  })
  @ApiResponse({ status: 200, type: [MessageDto] })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async listMessages(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query() query: ListMessagesDto,
  ): Promise<MessageDto[]> {
    return this.collab.listMessages(req.user!.userId, tripId, query);
  }

  @Post('messages')
  @ApiOperation({ summary: 'Post a chat message to the trip' })
  @ApiResponse({ status: 201, type: MessageDto })
  @ApiResponse({ status: 404, description: 'Trip not found or not visible' })
  async createMessage(
    @Req() req: express.Request,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageDto> {
    return this.collab.createMessage(req.user!.userId, tripId, dto);
  }
}
