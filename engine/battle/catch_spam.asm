; spam a to increase catch chance
; Implemented as reducing catch chance if you don't spam A.
; If you spam A hard enough you get the normal result you would in unmodded pokemon.
; If you don't, we randomly choose whether to force what would be a success into failure,
; with force-fail-chance proportional to the amount of A presses you did

; Wait 40 frames, and add the number of a presses during that time to wCatchPressCount
DelayAndCountASpam::
	ld c, 40
	ld e, 0 ; e = aWasPressed
.loop
	push bc
	push de
	call DelayFrame
	pop de
	pop bc
	ldh a, [hJoyInput]
	and PAD_A
	jr z, .notPressed
; A is pressed
	ld a, e
	and a
	jr nz, .afterInc ; if aWasPressed
	ld hl, wCatchPressCount
	inc [hl]
.afterInc
IF DEF(_DEBUG)
	call DebugPrintCatchCount
ENDC
	ld e, 1
	jr .next
.notPressed
	ld e, 0
.next
	dec c
	jr nz, .loop
	ret

DEF CATCH_SPAM_TARGET EQU 12 ; with this many presses, the catch chance is unmodified
DEF CATCH_SPAM_FLOOR EQU 64 ; minimum normalised catch chance (64/256 = 0.25)

; Called when the base game logic decides a catch should be successful, then plays the
; ball wobbling animation. Here we use the count of a presses from during the animation
; to determine if we force the catch to fail (random, less likely if you spammed hard)
ApplyCatchSpamPenalty::
; The Master Ball and the Old Man tutorial catch always succeed.
	ld a, [wCurItem]
	cp MASTER_BALL
	ret z
	ld a, [wBattleType]
	cp BATTLE_TYPE_OLD_MAN
	ret z

    ; If the player reached the target A press count, short circuit
	ld a, [wCatchPressCount]
	cp CATCH_SPAM_TARGET
	jr nc, .fullChance

	; calculate presses * 256 / CATCH_SPAM_TARGET

	; dividend = presses << 8; aka dividend = presses * 256
	ld b, a ; b = presses
	xor a
	ldh [hDividend], a
	ldh [hDividend + 1], a
	ld a, b
	ldh [hDividend + 2], a
	xor a
	ldh [hDividend + 3], a

	; divisor = CATCH_SPAM_TARGET
	ld a, CATCH_SPAM_TARGET
	ldh [hDivisor], a

	; do the divide
	ld b, 4
	call Divide

	ldh a, [hQuotient + 3] ; multiplier = lobyte(dividend / divisor)

	; multiplier = max(multiplier, CATCH_SPAM_FLOOR)
	cp CATCH_SPAM_FLOOR
	jr nc, .haveMultiplier
	ld a, CATCH_SPAM_FLOOR
.haveMultiplier

	ld b, a ; b = multiplier
IF DEF(_DEBUG)
	call DebugPrintCatchMultiplier
ENDC

    ; catch if rand() < multiplier, otherwise the Pokémon breaks free.
	call Random
	cp b
	ret c ; caught: don't modify wPokeBallAnimData

    ; Break free: bring the Pokémon back on screen and mark this as a break-out
	ld a, POOF_ANIM
	ld [wAnimationID], a
	farcall PlayAnimation
	ld a, SHOWPIC_ANIM
	ld [wAnimationID], a
	farcall PlayAnimation
	ld a, $62 ; "Aww! It appeared to be caught!" value
	ld [wPokeBallAnimData], a
	ret

.fullChance
IF DEF(_DEBUG)
	ld b, $ff ; ~100% for the debug readout
	call DebugPrintCatchMultiplier
ENDC
	ret

IF DEF(_DEBUG)

; Print the current A-press count in the top-right corner
DebugPrintCatchCount:
	push hl
	push de
	push bc
	hlcoord 13, 0 ; top-right
	ld de, wCatchPressCount
	ld b, LEADING_ZEROES | 1 ; print w/ leading zeros, one byte number
	ld c, 3 ; three digits
	call PrintNumber
	pop bc
	pop de
	pop hl
	ret

; Print the catch multiplier next to the a press count
DebugPrintCatchMultiplier:
	push hl
	push de
	push bc
	ld a, b
	ldh [hMultiplyBuffer], a
	hlcoord 13, 1
	ld de, hMultiplyBuffer
	ld b, LEADING_ZEROES | 1
	ld c, 3
	call PrintNumber
	pop bc
	pop de
	pop hl
	ret
ENDC
