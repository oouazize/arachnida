NAME	= spider scorpion

all: $(NAME)

node_modules: package.json
	npm install --silent
	@touch node_modules

dist/spider.js dist/scorpion.js: src/spider.ts src/scorpion.ts tsconfig.json | node_modules
	npx tsc

# Small launcher so the programs run as ./spider and ./scorpion
$(NAME): %: dist/%.js
	@printf '#!/bin/sh\nexec node "$$(dirname "$$0")/dist/$@.js" "$$@"\n' > $@
	@chmod +x $@
	@echo "built ./$@"

clean:
	rm -rf dist

fclean: clean
	rm -f $(NAME)
	rm -rf node_modules

re: fclean all

.PHONY: all clean fclean re
