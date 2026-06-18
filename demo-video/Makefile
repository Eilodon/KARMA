# Convenience wrapper around build.sh. Run from anywhere: `make -C demo-video video`
.PHONY: video offline preflight capture render shot tts assemble studio clean

video:        ## full build (live capture if KEYSTORE_PASSWORD set)
	./build.sh

offline:      ## full video, no chain spend (real discover + placeholders)
	./build.sh --no-live

assemble:     ## re-assemble only (reuse captures, narration, shots)
	./build.sh --skip-capture --skip-tts --skip-shot

preflight:    ## check wallet budget only
	@source ./config.sh && BETA_COST_WEI=$$BETA_COST_WEI ALPHA_COST_WEI=$$ALPHA_COST_WEI \
	 TRUSTGATE_ALPHA_WEI=$$TRUSTGATE_ALPHA_WEI SAFETY_RUNS=$$SAFETY_RUNS \
	 pnpm -s exec tsx ./preflight.mts

studio:       ## open Remotion studio to preview/scrub
	cd remotion && npx remotion studio

clean:        ## remove generated artifacts (keeps tools + node_modules)
	rm -rf out/* remotion/public/* remotion/src/manifest.json remotion/out/*
