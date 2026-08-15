import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * The Checkout Session id Stripe substitutes into the success URL.
 *
 * It arrives through the rider's address bar, so it is treated as UNTRUSTED
 * input: the service reads the session back from Stripe and checks it belongs
 * to the caller. Nothing about the response is derived from this string alone.
 */
export class VerifyCheckoutSessionDto {
  @ApiProperty({
    description:
      'Stripe Checkout Session id from the success URL (`cs_...`). Verified against Stripe and bound to the authenticated rider.',
  })
  @IsString()
  // Stripe session ids are ~66 chars today; the bound is a sanity cap on
  // request size, not a format claim — the id is validated by looking it up.
  @Length(1, 255)
  session_id!: string;
}

/**
 * The result of verifying a completed Checkout.
 *
 * Deliberately narrow: the companion needs to know whether it may say "your
 * free trial has started", and nothing else. Every field is a fact confirmed
 * with Stripe for THIS rider's session — a status the caller cannot cause by
 * editing the URL.
 */
export class VerifyCheckoutSessionResponseDto {
  @ApiProperty({
    description:
      'Whether the session completed successfully AND belongs to the authenticated rider. False for an unknown id, an unfinished checkout, or another rider’s session.',
  })
  completed!: boolean;

  @ApiProperty({
    description:
      'Whether the subscription this checkout created actually started on a free trial. Only meaningful when `completed` is true.',
  })
  trial_started!: boolean;
}
