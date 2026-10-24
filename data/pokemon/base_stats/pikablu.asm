	db DEX_PIKABLU ; pokedex id

	db  70,  20,  50,  40,  50
	;   hp  atk  def  spd  spc

	db WATER, WATER ; type
	db 190 ; catch rate
	db 58 ; base exp

	INCBIN "gfx/pokemon/front/pikablu.pic", 0, 1 ; sprite dimensions
	dw PikabluPicFront, PikabluPicBack

	db TACKLE, NO_MOVE, NO_MOVE, NO_MOVE ; level 1 learnset
	db GROWTH_FAST ; growth rate

	; tm/hm learnset
	tmhm TOXIC,        ICE_BEAM,     BLIZZARD,     HYPER_BEAM,   SWIFT,        \
	     REST,         DOUBLE_TEAM,  SURF,         STRENGTH
	; end

	db 0 ; padding
