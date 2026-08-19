import { Test, TestingModule } from '@nestjs/testing';
import { authGuardTestProviders } from '../auth/auth-test-providers.js';
import { TripCollabController } from './trip-collab.controller.js';
import { TripCollabService } from './trip-collab.service.js';

describe('TripCollabController', () => {
  let controller: TripCollabController;
  let service: jest.Mocked<TripCollabService>;

  const mockReq = { user: { userId: 'user-1' } } as never;
  const TRIP_ID = '11111111-1111-1111-1111-111111111111';
  const SUGGESTION_ID = '33333333-3333-3333-3333-333333333333';

  const mockSuggestion = {
    id: SUGGESTION_ID,
    trip_id: TRIP_ID,
    trip_day_id: null,
    suggested_by: 'user-1',
    suggester_display_name: 'Adam',
    road_segment_id: null,
    title: 'Detour',
    description: null,
    lat: null,
    lng: null,
    status: 'open',
    up_votes: 0,
    down_votes: 0,
    caller_vote: null,
    created_at: '2026-04-24T10:00:00.000Z',
    updated_at: '2026-04-24T10:00:00.000Z',
  };

  const mockMessage = {
    id: 'msg-1',
    trip_id: TRIP_ID,
    user_id: 'user-1',
    author_display_name: 'Adam',
    body: 'hi',
    created_at: '2026-04-24T10:00:00.000Z',
  };

  beforeEach(async () => {
    const mockService = {
      listSuggestions: jest.fn().mockResolvedValue([mockSuggestion]),
      createSuggestion: jest.fn().mockResolvedValue(mockSuggestion),
      deleteSuggestion: jest.fn().mockResolvedValue(undefined),
      voteSuggestion: jest.fn().mockResolvedValue(mockSuggestion),
      unvoteSuggestion: jest.fn().mockResolvedValue(mockSuggestion),
      listMessages: jest.fn().mockResolvedValue([mockMessage]),
      createMessage: jest.fn().mockResolvedValue(mockMessage),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripCollabController],
      providers: [
        { provide: TripCollabService, useValue: mockService },
        ...authGuardTestProviders,
      ],
    }).compile();

    controller = module.get(TripCollabController);
    service = module.get(TripCollabService);
  });

  it('GET /trips/:id/suggestions forwards to the service', async () => {
    const result = await controller.listSuggestions(mockReq, TRIP_ID);
    expect(service.listSuggestions).toHaveBeenCalledWith('user-1', TRIP_ID);
    expect(result).toHaveLength(1);
  });

  it('POST /trips/:id/suggestions forwards the body', async () => {
    const dto = { title: 'Detour' };
    const result = await controller.createSuggestion(mockReq, TRIP_ID, dto);
    expect(service.createSuggestion).toHaveBeenCalledWith(
      'user-1',
      TRIP_ID,
      dto,
    );
    expect(result.id).toBe(SUGGESTION_ID);
  });

  it('DELETE /trips/:id/suggestions/:sid returns void', async () => {
    await controller.deleteSuggestion(mockReq, TRIP_ID, SUGGESTION_ID);
    expect(service.deleteSuggestion).toHaveBeenCalledWith(
      'user-1',
      TRIP_ID,
      SUGGESTION_ID,
    );
  });

  it('POST /trips/:id/suggestions/:sid/vote forwards the vote value', async () => {
    await controller.voteSuggestion(mockReq, TRIP_ID, SUGGESTION_ID, {
      vote: 'up',
    });
    expect(service.voteSuggestion).toHaveBeenCalledWith(
      'user-1',
      TRIP_ID,
      SUGGESTION_ID,
      'up',
    );
  });

  it('DELETE /trips/:id/suggestions/:sid/vote clears the vote', async () => {
    await controller.unvoteSuggestion(mockReq, TRIP_ID, SUGGESTION_ID);
    expect(service.unvoteSuggestion).toHaveBeenCalledWith(
      'user-1',
      TRIP_ID,
      SUGGESTION_ID,
    );
  });

  it('GET /trips/:id/messages forwards pagination options', async () => {
    await controller.listMessages(mockReq, TRIP_ID, {
      limit: 10,
      before: '2026-04-24T09:00:00.000Z',
    });
    expect(service.listMessages).toHaveBeenCalledWith('user-1', TRIP_ID, {
      limit: 10,
      before: '2026-04-24T09:00:00.000Z',
    });
  });

  it('POST /trips/:id/messages creates a message', async () => {
    const dto = { body: 'hi' };
    const result = await controller.createMessage(mockReq, TRIP_ID, dto);
    expect(service.createMessage).toHaveBeenCalledWith('user-1', TRIP_ID, dto);
    expect(result.body).toBe('hi');
  });
});
