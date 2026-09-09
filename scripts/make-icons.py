#!/usr/bin/env python3
"""make-icons.py - the NoVo app icon family, generated from one path.

THE MARK is Jake's own brush drawing (2026-09-09), traced at the "black" weight and centred in a
120-unit square field. It is stored ONCE, below, and every file this script writes is rendered from
it - the SVGs and the PNGs alike. The previous version of this script re-drew the mark as polygons
in PIL while the SVGs held their own copy, which is two hand-maintained definitions of one shape and
exactly how they drift apart.

Rasterising goes through headless Chrome rather than a Python drawing library, because the mark is
a traced Bezier outline and nothing in PIL strokes those faithfully. Chrome renders the same SVG a
browser would, so what ships and what you preview are the same pixels.

THE RULE THE TILES FOLLOW: the tile IS the brand colour and the mark is a hole in it. A dark icon on
a black wallpaper has no edge and disappears - see the neighbours on any phone home screen.

    python3 scripts/make-icons.py            # writes into public/
    CHROME=/path/to/chrome python3 scripts/make-icons.py
"""
import base64, json, math, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(HERE, "public")

INK = "#0B0D10"

# The three product accents, read from each dashboard's own CSS rather than picked. These are the
# source of truth and they do not change here - the UI keeps using them exactly as they are.
ACCENTS = {
    "":        ("#22D3EE", "analyst"),   # analyst-live.html  --askacc
    "trader":  ("#10B981", "trader"),    # the site's canonical --green
    "crypto":  ("#A78BFA", "crypto"),    # crypto-live.html   --askacc
}

# An icon tile is not a UI accent and should not be one. On a home screen it competes with
# Robinhood and Coinbase, which both run their tile hotter than anything inside their app. So the
# tile is DERIVED from the accent by one rule, applied identically to all three:
#
#     Keep the hue exactly. Ride the sRGB gamut edge - the most saturated colour that exists at
#     that hue. Move the lightness ELECTRIC of the way from the accent's own lightness to the
#     lightness where that hue peaks.
#
# Hue is never touched, so a tile is unmistakably the same colour as its product - just its most
# electric form. Nothing here is a picked hex; change ELECTRIC and all three move together.
#
# Two things about this that are not obvious, and cost a round to learn:
#
#   * Adding chroma to these accents does nothing. Cyan and violet already sit ON the sRGB edge,
#     so a bigger chroma number is silently clamped straight back. The only way to get more
#     saturation out of a hue is to move to the LIGHTNESS where that hue has more to give.
#   * That lightness is not always brighter. Green peaks far brighter than #10B981; violet peaks
#     far DARKER than #A78BFA. Uniformly brightening would have made violet paler and less
#     saturated - the opposite of electric.
#
# ELECTRIC = 1.0 is each hue's absolute peak, and overshoots: green turns mint, violet turns
# indigo. 0.75 is as far as the hues still read as NoVo's.
ELECTRIC = 0.75

MARK_TRANSFORM = 'scale(0.043) translate(0.000000,2820.000000) scale(0.100000,-0.100000)'
MARK_PATH = 'M21854 25546 c-57 -18 -228 -115 -369 -210 -284 -189 -686 -408\n-1115 -606 -69 -32 -215 -99 -325 -150 -319 -148 -645 -296 -712 -324 -255\n-107 -546 -223 -718 -285 -60 -22 -166 -60 -235 -86 -69 -26 -143 -52 -165\n-60 -22 -7 -83 -29 -135 -48 -52 -19 -241 -87 -420 -151 -179 -63 -399 -143\n-490 -176 -91 -34 -194 -72 -230 -85 -36 -13 -108 -40 -160 -60 -52 -20 -124\n-47 -160 -60 -225 -81 -279 -101 -410 -144 -80 -27 -163 -56 -185 -64 -137\n-50 -276 -89 -301 -83 -15 4 -61 38 -103 76 -58 51 -109 85 -211 136 -135 69\n-135 69 -490 69 -355 0 -355 0 -480 -64 -248 -127 -434 -343 -523 -611 -14\n-41 -40 -111 -57 -155 -34 -85 -73 -189 -119 -320 -16 -44 -43 -116 -61 -160\n-17 -44 -40 -105 -51 -135 -37 -110 -97 -278 -138 -390 -23 -63 -55 -151 -71\n-195 -15 -44 -47 -132 -71 -195 -52 -141 -116 -320 -135 -380 -8 -25 -34 -94\n-59 -155 -24 -60 -65 -166 -91 -235 -26 -69 -60 -159 -76 -200 -17 -41 -41\n-104 -55 -140 -13 -36 -46 -121 -73 -190 -86 -217 -200 -511 -247 -635 -25\n-66 -70 -182 -99 -257 -30 -76 -54 -140 -54 -144 0 -3 -29 -78 -64 -167 -35\n-89 -76 -196 -91 -237 -29 -81 -85 -227 -188 -490 -36 -91 -68 -176 -72 -190\n-4 -14 -30 -79 -57 -145 -28 -66 -70 -172 -94 -235 -23 -63 -73 -187 -109\n-275 -37 -88 -77 -189 -90 -225 -13 -36 -51 -132 -85 -215 -34 -82 -75 -181\n-90 -220 -15 -38 -53 -133 -85 -210 -31 -77 -72 -178 -90 -225 -18 -47 -49\n-122 -69 -167 -20 -45 -36 -84 -36 -87 0 -3 -34 -88 -76 -188 -42 -101 -87\n-210 -99 -243 -13 -33 -40 -98 -60 -145 -20 -47 -66 -157 -102 -245 -35 -88\n-77 -189 -93 -225 -16 -36 -41 -96 -56 -135 -15 -38 -44 -106 -64 -150 -21\n-44 -41 -91 -45 -105 -4 -14 -44 -108 -88 -210 -80 -185 -80 -185 -84 -300 -6\n-186 -1 -189 275 -174 150 9 185 14 227 33 35 16 79 25 145 30 65 5 111 15\n145 30 34 16 80 25 145 30 65 5 111 15 145 30 33 15 82 26 145 31 60 5 113 16\n145 30 30 13 85 24 140 29 49 5 108 16 130 25 22 10 84 22 138 26 62 6 115 17\n145 31 30 13 81 24 143 29 177 14 276 77 327 205 11 28 36 88 57 135 20 47 45\n108 55 135 10 28 37 93 58 145 22 52 60 145 85 206 25 62 65 156 87 210 45\n107 168 408 232 567 49 125 85 184 101 168 18 -18 14 -311 -7 -468 -15 -121\n-23 -262 -42 -800 -10 -259 -7 -263 177 -263 87 0 121 4 167 21 32 12 99 25\n152 29 63 5 112 15 145 30 35 16 80 24 150 29 71 5 114 14 150 30 36 17 80 25\n155 31 75 6 120 14 155 31 35 16 79 24 150 29 67 5 118 14 155 29 34 14 92 26\n155 31 73 6 119 17 169 38 109 45 108 41 117 309 4 125 15 280 23 343 9 63 20\n246 26 405 6 160 19 385 30 500 23 236 40 529 40 683 0 56 9 176 19 265 22\n179 41 482 41 652 0 61 7 157 15 215 18 126 45 524 45 670 0 58 7 155 15 215\n16 124 32 358 45 675 5 118 16 260 25 315 9 55 20 219 25 365 7 211 13 283 30\n355 16 71 23 141 29 325 4 130 10 240 13 245 3 6 11 53 17 105 8 61 21 115 37\n150 21 43 28 81 36 179 15 195 11 191 214 191 112 0 144 4 192 21 31 12 79 28\n107 35 27 8 79 25 115 38 36 13 88 31 115 40 57 18 181 61 305 106 47 17 117\n42 155 55 39 13 93 33 120 44 28 11 131 50 230 86 99 36 191 71 205 77 14 5\n86 32 160 58 74 26 245 87 380 135 135 48 277 98 315 112 39 13 131 46 205 74\n74 28 173 64 220 80 87 31 98 36 255 96 50 19 113 42 140 52 28 10 73 28 100\n39 28 11 93 37 145 57 52 20 120 47 150 60 159 70 479 213 749 336 302 138\n336 150 359 127 32 -32 16 -71 -129 -328 -36 -63 -121 -214 -189 -335 -67\n-121 -153 -272 -190 -335 -37 -63 -79 -135 -93 -160 -13 -25 -107 -189 -207\n-365 -101 -176 -245 -430 -320 -565 -76 -135 -188 -335 -250 -445 -62 -110\n-171 -306 -243 -435 -71 -129 -162 -293 -202 -365 -115 -205 -185 -335 -185\n-341 0 -3 -29 -56 -64 -117 -59 -104 -182 -335 -314 -587 -30 -58 -58 -109\n-62 -115 -44 -58 -663 -1318 -1014 -2063 -43 -90 -109 -230 -148 -310 -39 -81\n-78 -165 -88 -187 -10 -22 -88 -188 -175 -370 -189 -397 -201 -424 -303 -640\n-44 -93 -97 -206 -118 -250 -46 -96 -57 -256 -21 -292 31 -32 188 -31 288 1\n59 19 102 26 159 26 61 0 95 6 147 26 49 18 99 28 178 34 67 5 126 15 150 26\n25 11 81 20 150 25 78 5 126 13 165 30 40 16 86 24 170 29 87 6 127 13 165 30\n37 17 79 24 165 30 86 6 128 13 165 30 38 17 79 24 170 30 83 5 136 14 170 28\n28 11 71 27 96 36 26 9 53 24 62 34 14 15 147 275 147 286 0 3 33 74 74 158\n40 84 102 212 136 283 327 688 453 947 628 1300 113 226 244 482 292 570 48\n88 124 231 169 319 45 87 92 174 105 195 12 20 67 119 121 221 54 102 117 219\n140 260 23 41 129 233 235 425 204 370 502 900 605 1075 34 58 113 197 175\n310 62 113 123 221 136 242 13 20 72 126 132 235 60 109 167 299 239 423 190\n329 260 453 321 565 30 55 97 172 147 260 51 88 112 193 135 233 58 102 77\n112 213 112 136 0 161 -10 218 -93 23 -34 68 -98 99 -142 32 -44 119 -168 195\n-275 430 -608 937 -1268 1240 -1614 353 -404 856 -957 942 -1036 37 -34 103\n-78 174 -115 114 -60 114 -60 399 -60 285 0 285 0 389 55 172 91 261 200 261\n321 0 27 11 83 25 125 37 113 37 374 1 467 -14 34 -32 84 -42 111 -29 87 -144\n244 -306 416 -373 398 -484 523 -923 1040 -38 46 -105 128 -148 184 -44 55\n-98 124 -121 151 -23 28 -69 86 -102 130 -33 44 -107 141 -164 215 -119 155\n-404 547 -579 795 -42 61 -109 155 -147 210 -39 55 -101 143 -138 195 -36 52\n-114 160 -171 240 -58 80 -136 190 -174 245 -333 479 -436 636 -546 835 -31\n58 -70 121 -85 140 -14 19 -43 60 -63 90 -37 57 -71 81 -236 167 -63 33 -63\n33 -250 33 -206 0 -229 6 -381 101 -104 65 -93 63 -380 66 -197 2 -275 -1\n-306 -11z M23915 15130 c-71 -4 -173 -15 -225 -24 -52 -9 -185 -21 -295 -26\n-110 -5 -254 -19 -320 -30 -66 -11 -196 -25 -290 -30 -93 -5 -197 -16 -230\n-24 -33 -8 -116 -20 -185 -26 -159 -14 -258 -27 -340 -45 -36 -8 -112 -17\n-170 -21 -58 -3 -143 -15 -190 -25 -47 -11 -157 -27 -245 -35 -88 -7 -185 -21\n-215 -29 -30 -9 -118 -20 -195 -26 -77 -5 -176 -18 -220 -29 -44 -11 -141 -25\n-215 -30 -74 -5 -171 -19 -214 -30 -44 -12 -136 -25 -205 -30 -69 -4 -163 -18\n-209 -29 -46 -12 -141 -26 -210 -31 -70 -6 -160 -19 -201 -30 -41 -11 -117\n-23 -170 -26 -53 -3 -143 -17 -201 -29 -58 -13 -145 -27 -195 -30 -49 -4 -128\n-15 -173 -26 -46 -10 -143 -26 -215 -34 -73 -8 -157 -22 -187 -30 -30 -8 -108\n-20 -174 -25 -65 -6 -156 -19 -203 -30 -46 -12 -135 -25 -196 -31 -61 -5 -149\n-19 -196 -30 -46 -11 -132 -24 -190 -29 -58 -5 -144 -18 -191 -29 -47 -12\n-123 -24 -170 -27 -47 -3 -132 -17 -190 -29 -58 -13 -143 -27 -190 -30 -47 -4\n-132 -17 -190 -30 -58 -13 -139 -26 -180 -30 -41 -3 -112 -15 -158 -26 -46\n-11 -130 -24 -187 -29 -57 -5 -142 -19 -190 -30 -48 -11 -133 -25 -189 -30\n-56 -5 -138 -18 -182 -29 -43 -12 -128 -25 -189 -30 -60 -6 -128 -16 -150 -24\n-52 -18 -89 -25 -215 -36 -58 -6 -125 -17 -149 -26 -24 -8 -103 -22 -175 -30\n-72 -8 -153 -22 -181 -30 -27 -9 -95 -20 -150 -26 -55 -5 -132 -19 -172 -30\n-39 -11 -120 -24 -180 -29 -59 -6 -139 -19 -178 -30 -38 -11 -119 -25 -180\n-30 -60 -5 -141 -19 -180 -30 -38 -11 -119 -25 -180 -30 -60 -5 -144 -19 -185\n-30 -41 -11 -124 -25 -185 -30 -60 -5 -130 -16 -155 -25 -25 -9 -92 -21 -150\n-26 -58 -6 -154 -21 -215 -35 -60 -13 -146 -26 -190 -29 -44 -4 -115 -15 -158\n-26 -43 -11 -124 -24 -180 -29 -56 -6 -137 -20 -180 -30 -42 -11 -119 -25\n-170 -30 -52 -5 -131 -19 -178 -30 -46 -11 -117 -22 -159 -26 -41 -3 -120 -16\n-175 -29 -55 -13 -147 -28 -205 -34 -58 -6 -127 -17 -155 -26 -27 -8 -108 -22\n-180 -30 -71 -8 -152 -22 -180 -30 -27 -9 -97 -20 -155 -26 -58 -5 -136 -18\n-175 -29 -38 -11 -114 -24 -168 -30 -54 -5 -132 -19 -174 -30 -42 -11 -122\n-24 -178 -30 -56 -5 -114 -14 -130 -20 -45 -17 -110 -30 -208 -40 -51 -5 -112\n-16 -135 -24 -24 -9 -93 -22 -155 -30 -62 -9 -134 -23 -162 -31 -27 -9 -95\n-20 -149 -26 -55 -5 -136 -20 -180 -33 -45 -13 -120 -26 -167 -30 -47 -3 -112\n-15 -145 -26 -32 -12 -104 -25 -159 -30 -55 -5 -126 -18 -159 -29 -32 -12 -88\n-23 -125 -27 -36 -3 -104 -16 -151 -30 -47 -13 -125 -28 -173 -33 -48 -6 -120\n-19 -160 -30 -40 -11 -108 -25 -153 -30 -44 -6 -113 -19 -152 -30 -39 -11 -97\n-23 -129 -26 -32 -4 -100 -18 -152 -31 -51 -13 -106 -24 -121 -24 -15 0 -72\n-11 -125 -25 -53 -14 -132 -30 -174 -36 -42 -5 -108 -19 -147 -30 -39 -10\n-105 -23 -148 -29 -43 -5 -106 -18 -140 -29 -34 -10 -89 -22 -121 -26 -33 -4\n-100 -17 -150 -30 -49 -13 -112 -27 -140 -30 -27 -4 -88 -17 -135 -30 -47 -13\n-112 -26 -145 -30 -33 -4 -98 -18 -144 -31 -46 -13 -97 -24 -115 -25 -17 0\n-62 -9 -101 -20 -38 -10 -115 -28 -170 -38 -55 -11 -119 -26 -141 -34 -23 -9\n-76 -21 -119 -27 -42 -6 -101 -20 -130 -30 -29 -10 -80 -22 -112 -25 -32 -4\n-92 -18 -133 -30 -41 -13 -97 -26 -125 -30 -27 -4 -76 -16 -109 -26 -32 -11\n-91 -26 -130 -33 -39 -7 -105 -22 -146 -34 -41 -12 -102 -28 -135 -36 -78 -19\n-176 -44 -245 -63 -30 -8 -82 -22 -115 -30 -33 -9 -94 -26 -135 -39 -41 -13\n-97 -28 -125 -34 -27 -6 -72 -19 -100 -29 -27 -10 -104 -35 -170 -56 -66 -20\n-149 -47 -185 -60 -36 -12 -87 -30 -115 -38 -76 -23 -281 -103 -364 -143 -106\n-49 -247 -189 -299 -293 -36 -74 -37 -77 -40 -211 -3 -101 1 -153 12 -197 9\n-34 16 -78 16 -99 0 -50 38 -130 81 -171 53 -49 293 -163 345 -163 8 0 47 -11\n87 -25 39 -14 106 -28 147 -31 41 -4 116 -17 165 -30 58 -15 134 -26 215 -30\n69 -3 163 -15 210 -25 60 -14 154 -22 325 -29 202 -9 366 -24 485 -46 14 -2\n223 -8 465 -14 289 -6 481 -14 560 -24 167 -22 649 -36 1240 -35 275 0 1094\n-8 1820 -17 1435 -18 1365 -15 1365 -73 0 -31 -268 -570 -473 -953 -214 -400\n-259 -483 -267 -493 -4 -5 -69 -116 -143 -245 -74 -129 -171 -296 -217 -370\n-45 -74 -105 -173 -133 -220 -27 -47 -75 -123 -105 -170 -30 -47 -80 -125\n-111 -173 -329 -515 -601 -895 -937 -1307 -135 -166 -175 -212 -417 -474 -122\n-132 -416 -395 -523 -469 -257 -176 -304 -207 -353 -232 -97 -48 -273 -231\n-326 -338 -25 -49 -45 -95 -45 -102 0 -8 -14 -47 -30 -88 -30 -75 -30 -75 -30\n-340 0 -237 2 -271 20 -327 11 -34 20 -86 20 -116 0 -65 11 -94 54 -147 18\n-23 45 -65 59 -93 25 -49 146 -174 169 -174 6 0 47 -21 90 -46 43 -25 113 -60\n156 -76 42 -17 93 -36 112 -44 26 -10 100 -13 293 -14 309 0 320 3 592 140\n279 141 461 265 760 515 320 268 814 788 1159 1220 339 424 650 873 1138 1645\n153 243 430 713 558 950 32 58 94 173 140 255 278 505 647 1237 885 1755 145\n317 153 328 247 340 101 12 165 56 229 158 28 44 51 68 74 78 51 21 1762 21\n1791 0 27 -21 25 -237 -5 -431 -11 -77 -25 -212 -30 -300 -6 -88 -19 -216 -30\n-285 -11 -69 -25 -213 -31 -320 -6 -107 -17 -231 -25 -275 -9 -44 -20 -161\n-25 -260 -12 -234 -18 -301 -36 -411 -8 -51 -19 -195 -24 -320 -12 -299 -19\n-381 -36 -484 -17 -103 -20 -724 -4 -780 6 -19 15 -66 20 -104 6 -48 17 -81\n39 -115 16 -25 46 -76 67 -114 39 -72 127 -161 181 -184 18 -7 65 -33 105 -57\n40 -24 92 -49 115 -55 23 -7 66 -23 95 -36 90 -42 640 -38 738 5 38 17 74 30\n82 30 7 0 49 21 93 46 44 25 101 56 126 69 152 78 392 420 629 896 164 328\n314 654 540 1174 64 147 112 256 155 355 19 41 49 113 68 160 42 103 59 143\n101 240 36 81 114 265 170 400 19 47 56 135 82 195 26 61 59 142 74 180 15 39\n54 135 87 215 154 374 449 1100 488 1205 23 59 92 224 140 336 14 31 31 74 39\n95 8 22 31 77 51 124 20 47 47 110 60 140 13 30 39 91 58 135 19 44 61 143 95\n220 33 77 74 172 92 210 17 39 72 165 122 280 50 116 110 253 133 305 24 52\n78 174 120 270 97 221 260 582 288 637 32 67 64 90 134 102 102 16 205 87 247\n170 60 117 161 164 386 176 72 4 147 16 200 30 51 14 129 26 195 30 66 4 144\n15 195 30 54 15 126 25 195 29 71 3 134 13 175 26 43 13 112 24 200 29 84 6\n161 17 205 29 40 12 126 25 200 31 72 5 166 18 210 29 44 11 136 23 204 27 70\n4 156 15 195 26 39 11 130 24 201 29 72 5 166 19 210 31 47 12 135 24 215 29\n75 4 174 17 222 29 49 12 151 26 230 31 79 5 166 16 193 25 28 9 124 22 215\n30 91 7 201 22 245 33 47 12 149 24 245 30 94 6 202 19 250 30 60 14 138 22\n265 26 136 4 210 12 300 31 95 20 150 25 265 25 80 0 199 6 265 12 68 6 245\n10 410 9 290 -3 290 -3 372 38 98 47 113 68 123 164 4 40 13 93 20 119 24 91\n10 303 -25 373 -39 79 -166 209 -214 218 -44 9 -947 6 -1116 -3z m-8210 -2156\nc21 -22 16 -44 -40 -164 -24 -52 -73 -165 -109 -250 -107 -255 -165 -382 -183\n-402 -47 -52 -68 93 -39 264 8 51 20 133 25 182 8 64 19 107 41 153 24 49 49\n140 50 180 1 37 223 68 255 37z m-2417 -402 c46 -46 55 -390 17 -637 -8 -55\n-22 -219 -30 -365 -8 -146 -21 -308 -30 -360 -8 -52 -20 -189 -25 -305 -19\n-379 -24 -390 -132 -340 -53 25 -53 25 -793 25 -748 0 -796 2 -831 37 -26 27\n-13 73 89 303 52 118 126 289 165 380 39 91 96 224 127 295 32 72 68 155 80\n185 147 351 150 355 245 383 109 32 194 98 241 188 58 111 107 135 317 155 91\n8 168 21 202 33 31 12 83 21 120 22 36 0 90 4 120 9 88 12 99 11 118 -8z\nm-3634 -593 c36 -17 38 -46 10 -114 -15 -33 -37 -87 -51 -120 -25 -60 -86\n-199 -188 -430 -30 -66 -97 -219 -150 -340 -137 -314 -146 -332 -173 -357 -24\n-23 -24 -23 -1585 -22 -1074 0 -1621 4 -1751 12 -321 20 -632 32 -1131 43\n-264 5 -514 14 -555 19 -41 6 -155 16 -252 24 -152 13 -218 25 -218 40 0 12\n187 76 248 85 41 6 90 18 110 27 20 8 77 22 127 30 49 9 105 22 123 30 19 7\n75 20 126 29 51 8 110 22 132 31 21 9 72 21 113 26 41 5 99 18 130 29 31 11\n91 24 133 30 42 5 111 21 153 34 41 14 93 25 115 25 22 0 74 11 117 25 43 14\n115 30 161 35 45 6 106 19 135 30 28 11 90 25 137 30 47 5 117 21 155 34 46\n17 91 26 132 26 41 0 86 9 134 26 39 14 110 29 158 34 47 4 110 18 140 30 31\n12 96 25 150 30 53 5 119 18 146 28 28 11 88 23 135 27 47 3 110 16 140 26 30\n11 96 24 145 29 50 6 126 21 170 34 44 13 114 27 155 30 41 3 102 14 134 26\n32 11 102 24 155 29 53 5 123 18 156 29 33 11 103 25 156 31 53 6 115 18 139\n26 24 8 86 20 138 26 52 6 122 19 156 30 33 11 106 24 161 29 55 5 130 18 167\n30 36 11 111 25 165 30 54 5 126 19 161 30 35 11 107 24 160 29 53 5 122 17\n152 27 48 14 124 28 182 33 9 0 28 -4 42 -10z'


# --- deriving the tile colours ------------------------------------------------------------------
# OKLab, because it is the only common space where "same hue, more saturation" means what it says.
# In HSL, raising saturation on cyan and violet does nothing (they are already at the edge) and
# changing lightness swings the apparent hue; OKLab holds hue steady while the other two move.

def _srgb_to_lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def _lin_to_srgb(c): return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def _hex_to_oklch(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    r, g, b = map(_srgb_to_lin, (r, g, b))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (v ** (1 / 3) if v > 0 else -((-v) ** (1 / 3)) for v in (l, m, s))
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    b2 = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(a, b2), math.atan2(b2, a)


def _oklch_to_rgb(L, C, h):
    a, b_ = C * math.cos(h), C * math.sin(h)
    l = (L + 0.3963377774 * a + 0.2158037573 * b_) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b_) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b_) ** 3
    return [_lin_to_srgb(v) for v in (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)]


def _max_chroma(L, h, eps=1e-4):
    """The largest chroma sRGB can actually show at this lightness and hue - the gamut edge."""
    lo, hi = 0.0, 0.45
    for _ in range(48):
        mid = (lo + hi) / 2
        if all(-eps <= v <= 1 + eps for v in _oklch_to_rgb(L, mid, h)):
            lo = mid
        else:
            hi = mid
    return lo


def electric(hexc, amount=None):
    """The accent, same hue, ridden to the sRGB edge, `amount` of the way toward its chroma peak.

    Clamping is by chroma only and lightness is chosen, never clipped, so the returned colour is
    always exactly the input hue - it cannot quietly become a neighbouring one.
    """
    amount = ELECTRIC if amount is None else amount
    L0, _C0, h = _hex_to_oklch(hexc)
    peakL = max(range(200, 981), key=lambda t: _max_chroma(t / 1000, h)) / 1000
    L = L0 + (peakL - L0) * amount
    rgb = _oklch_to_rgb(L, _max_chroma(L, h), h)
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in rgb)


GROUNDS = {tag: (electric(hexc), name) for tag, (hexc, name) in ACCENTS.items()}


def chrome():
    """Find a Chrome/Chromium that can screenshot. Named explicitly so a failure says what to do."""
    cand = [os.environ.get("CHROME")] + [
        shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser", "chrome")
    ] + [
        "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for c in cand:
        if c and os.path.exists(c):
            return c
    sys.exit("No Chrome found. Install Chrome or set CHROME=/path/to/chrome and re-run.")


def svg(ground=None, scale=0.80, square=False, ink=INK):
    """One tile. `square` skips the rounded corners - every launcher applies its own crop and iOS
    rounds what you hand it, so a pre-rounded source shows a second corner inside the first."""
    rx = "" if square else ' rx="27"'
    bg = f'<rect width="120" height="120"{rx} fill="{ground}"/>' if ground else ""
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">'
            + bg
            + f'<g transform="translate(60,60) scale({scale}) translate(-60,-60)">'
            + f'<g transform="{MARK_TRANSFORM}" fill="{ink}"><path d="{MARK_PATH}"/></g></g></svg>')


RENDER_AT = 1024        # render once, large, then downsample to each target


def render(svg_text, px, path, exe):
    """Rasterise at RENDER_AT and resize down.

    ⚠ --window-size IS NOT THE VIEWPORT, and this cost two rounds. Chrome reports a 1024x1024
    screenshot while laying the page out in 1024x936, so an SVG told to fill 100% of the viewport
    letterboxes: the tile came out inset on three sides with a 44px band along the bottom. Sizing
    the element in viewport units has the same flaw for the same reason.

    So nothing here trusts the viewport. The SVG is given explicit pixel width and height, pinned
    at the top-left of a deliberately OVERSIZED window, and the screenshot is cropped to exactly
    those pixels. Rendering large and downsampling also antialiases the traced curves far better
    than asking Chrome for a 16px canvas.
    """
    from PIL import Image
    with tempfile.TemporaryDirectory() as td:
        html = os.path.join(td, "i.html")
        big = os.path.join(td, "big.png")
        # ⚠ The size goes on in CSS, NOT by rewriting width="120" height="120" in the markup.
        # The tile <rect> carries those exact same attributes, so a plain str.replace scaled the
        # rect too - to 1024 USER units on a 120 viewBox, 8.5x oversized. It still filled the tile
        # edge to edge, so coverage checks passed, but three of its four rounded corners were
        # pushed outside the crop and every rounded icon shipped with one rounded and three square
        # corners. CSS width/height apply to the root element only and override the attributes.
        with open(html, "w", encoding="utf-8") as f:
            f.write('<html style="background:transparent">'
                    '<body style="margin:0;padding:0;background:transparent">'
                    + svg_text.replace(
                        "<svg ",
                        f'<svg style="display:block;width:{RENDER_AT}px;height:{RENDER_AT}px" ', 1)
                    + "</body></html>")
        pad = RENDER_AT + 300      # comfortably bigger than any chrome the browser adds
        subprocess.run([exe, "--headless=new", "--no-sandbox", "--disable-gpu",
                        "--hide-scrollbars", "--default-background-color=00000000",
                        f"--window-size={pad},{pad}", f"--screenshot={big}",
                        "--virtual-time-budget=4000", "file://" + html],
                       capture_output=True, check=False)
        if not os.path.exists(big):
            sys.exit("Chrome wrote nothing - check the CHROME path")
        im = Image.open(big).convert("RGBA")
        if im.width < RENDER_AT or im.height < RENDER_AT:
            sys.exit(f"Chrome rendered {im.size}, smaller than the {RENDER_AT}px mark")
        im.crop((0, 0, RENDER_AT, RENDER_AT)).resize((px, px), Image.LANCZOS).save(path)


def write_ico(svg_text, sizes, path, exe):
    """An .ico holding one PNG frame per size, each rasterised from the vector at that size.

    Written by hand because PIL cannot assemble an .ico from independently rendered frames - its
    ICO writer takes one image and thumbnails it. The container is a 6-byte header, one 16-byte
    directory entry per frame, then the frame payloads; PNG-compressed entries are what every
    browser in use reads. Frames must be listed smallest-first, and a 256px frame would be encoded
    as width/height byte 0, which is why nothing here goes above 48.
    """
    import struct, tempfile
    frames = []
    with tempfile.TemporaryDirectory() as td:
        for px in sizes:
            f = os.path.join(td, f"{px}.png")
            render(svg_text, px, f, exe)
            frames.append((px, open(f, "rb").read()))

    offset = 6 + 16 * len(frames)
    header = struct.pack("<HHH", 0, 1, len(frames))
    directory, payload = b"", b""
    for px, data in frames:
        directory += struct.pack("<BBBBHHII", px, px, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        payload += data
    with open(path, "wb") as f:
        f.write(header + directory + payload)


def verify():
    """Check the two things that have silently gone wrong here before, and fail loudly.

    Both bugs that shipped from this script rendered something plausible: a letterboxed tile, and
    a tile with one rounded corner and three square ones. Neither is visible in a thumbnail, and
    both were caught by eye rounds later. Corner alpha and edge coverage are cheap to assert, so
    they are asserted rather than looked at.
    """
    from PIL import Image
    fails = []

    def corner_alpha(im):
        w, h = im.size
        return [im.getpixel(p)[3] for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]

    for tag in GROUNDS:
        t = f"-{tag}" if tag else ""
        # rounded: nothing masks these, so all four corners must be cut
        for name in (f"icon{t}-192.png", f"icon{t}-512.png"):
            im = Image.open(os.path.join(OUT, name)).convert("RGBA")
            if any(a != 0 for a in corner_alpha(im)):
                fails.append(f"{name}: expected four rounded corners, got alpha {corner_alpha(im)}")
            # and the tile must still reach every edge - the letterboxing bug
            for edge in (im.crop((0, im.height // 2, 1, im.height // 2 + 1)),
                         im.crop((im.width - 1, im.height // 2, im.width, im.height // 2 + 1)),
                         im.crop((im.width // 2, 0, im.width // 2 + 1, 1)),
                         im.crop((im.width // 2, im.height - 1, im.width // 2 + 1, im.height))):
                if edge.getpixel((0, 0))[3] < 250:
                    fails.append(f"{name}: tile does not reach an edge midpoint")
        # square on purpose: a launcher crop or iOS rounding is applied on top
        for name in (f"icon{t}-maskable-512.png", f"apple-touch-icon{t}.png"):
            im = Image.open(os.path.join(OUT, name)).convert("RGBA")
            if any(a != 255 for a in corner_alpha(im)):
                fails.append(f"{name}: must be square, got corner alpha {corner_alpha(im)}")

    ico = Image.open(os.path.join(OUT, "favicon.ico"))
    got = sorted(ico.info["sizes"])
    if got != [(16, 16), (32, 32), (48, 48)]:
        fails.append(f"favicon.ico frames are {got}")
    for sz in got:
        ico.size = sz
        if any(a != 0 for a in corner_alpha(ico.copy().convert("RGBA"))):
            fails.append(f"favicon.ico @{sz[0]}: expected four rounded corners")

    if fails:
        for f in fails:
            print("  FAIL", f)
        sys.exit(f"{len(fails)} icon checks failed - nothing above is safe to ship")
    print("  checks: corners and edge coverage OK")


def main():
    exe = chrome()
    written = []
    for tag, (hexc, _name) in GROUNDS.items():
        t = f"-{tag}" if tag else ""
        # 'any' icons: shown as drawn, so the mark can sit larger
        for px in (192, 512):
            p = os.path.join(OUT, f"icon{t}-{px}.png")
            render(svg(hexc, 0.80), px, p, exe); written.append(p)
        # 'maskable': every launcher crops its own shape, so the mark pulls in to the safe zone
        # and the ground runs full-bleed square.
        p = os.path.join(OUT, f"icon{t}-maskable-512.png")
        render(svg(hexc, 0.66, square=True), 512, p, exe); written.append(p)
        # apple-touch: iOS masks it itself. Square, or you get a corner inside a corner.
        p = os.path.join(OUT, f"apple-touch-icon{t}.png")
        render(svg(hexc, 0.80, square=True), 180, p, exe); written.append(p)

    # favicon: nothing masks it, so it keeps its rounding. Slightly larger mark - at 16px every
    # unit of the tile spent on margin is a unit the mark does not have.
    #
    # Each frame is rendered from the vector at its own size rather than resampling one bitmap
    # down three times. PIL's .save(sizes=[...]) would thumbnail a single raster into all three,
    # so the 16px frame would arrive via 1024 -> 64 -> 16; here it comes straight from 1024. On a
    # brush mark, where the whole shape is thin strokes and near-touching counters, that second
    # resample is the difference between a legible glyph and a smudge.
    ico = os.path.join(OUT, "favicon.ico")
    write_ico(svg(GROUNDS[""][0], 0.86), (16, 32, 48), ico, exe)
    written.append(ico)

    # the vector masters, from the same path
    for fill, name in [("currentColor", "novo-mark"), ("#22D3EE", "novo-mark-cyan"),
                       ("#10B981", "novo-mark-green"), ("#A78BFA", "novo-mark-violet"),
                       ("#0B0D10", "novo-mark-ink"), ("#EAF3FF", "novo-mark-white")]:
        p = os.path.join(OUT, f"{name}.svg")
        with open(p, "w", encoding="utf-8") as f:
            f.write(svg(None, 1.0, ink=fill) + "\n")
        written.append(p)
    for tag, (hexc, _n) in GROUNDS.items():
        t = f"-{tag}" if tag else ""
        p = os.path.join(OUT, f"novo-icon{t}.svg")
        with open(p, "w", encoding="utf-8") as f:
            f.write(svg(hexc, 0.80) + "\n")
        written.append(p)

    for w in written:
        print("  wrote", os.path.relpath(w, HERE), os.path.getsize(w), "bytes")
    print(f"{len(written)} files")
    verify()


if __name__ == "__main__":
    main()
