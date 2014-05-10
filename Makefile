#
# Copyright (c) 2014, Joyent, Inc. All rights reserved.
#
# Makefile for sdcadm
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdcadm
DOC_FILES	 = index.md design.md
RESTDOWN_EXT := .md
JS_FILES	:= bin/sdcadm \
	$(shell find lib -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
CLEAN_FILES += ./node_modules ./build/sdcadm-*.sh ./build/sdcadm-*.imgmanifest ./build/shar-image

NODE_PREBUILT_VERSION=v0.10.26
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=gz
	# sdc-smartos/1.6.3
	NODE_PREBUILT_IMAGE=fd2cc906-8938-11e3-beab-4359c665ac99
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif


#
# Targets
#
.PHONY: all
all: | $(NPM_EXEC)
	MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true' $(NPM) install

.PHONY: shar
shar:
	./tools/mk-shar -o $(TOP)/build -s $(STAMP)

.PHONY: test
test:
	./test/runtests

.PHONY: release
release: all shar

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp \
		$(TOP)/build/sdcadm-$(STAMP).sh \
		$(TOP)/build/sdcadm-$(STAMP).imgmanifest \
		$(BITS_DIR)/$(NAME)/

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.targ
