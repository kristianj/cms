/**
 * Asset index class
 */
Craft.AssetIndex = Craft.BaseElementIndex.extend(
{
	$includeSubfoldersContainer: null,
	$includeSubfoldersCheckbox: null,
	showingIncludeSubfoldersCheckbox: false,

	$uploadButton: null,
	$uploadInput: null,
	$progressBar: null,
	$folders: null,

	uploader: null,
	promptHandler: null,
	progressBar: null,

	_uploadTotalFiles: 0,
	_uploadFileProgress: {},
	_uploadedAssetIds: [],
	_currentUploaderSettings: {},

	_assetDrag: null,
	_folderDrag: null,
	_expandDropTargetFolderTimeout: null,
	_tempExpandedFolders: [],

	_fileConflictTemplate: {
		message: "File “{file}” already exists at target location.",
		choices: [
			{value: 'keepBoth', title: Craft.t('app', 'Keep both')},
			{value: 'replace', title: Craft.t('app', 'Replace it')}
		]
	},
	_folderConflictTemplate: {
		message: "Folder “{folder}” already exists at target location",
		choices: [
			{value: 'replace', title: Craft.t('app', 'Replace the folder (all existing files will be deleted)')},
			{value: 'merge', title: Craft.t('app', 'Merge the folder (any conflicting files will be replaced)')}
		]
	},


	init: function(elementType, $container, settings)
	{
		this.base(elementType, $container, settings);

		if (this.settings.context == 'index')
		{
			this._initIndexPageMode();
		}
	},

	initSource: function($source)
	{
		this.base($source);

		this._createFolderContextMenu($source);

		if (this.settings.context == 'index')
		{
			if (this._folderDrag && this._getSourceLevel($source) > 1)
			{
				this._folderDrag.addItems($source.parent());
			}

			if (this._assetDrag)
			{
				this._assetDrag.updateDropTargets();
			}
		}
	},

	deinitSource: function($source)
	{
		this.base($source);

		// Does this source have a context menu?
		var contextMenu = $source.data('contextmenu');

		if (contextMenu)
		{
			contextMenu.destroy();
		}

		if (this.settings.context == 'index')
		{
			if (this._folderDrag && this._getSourceLevel($source) > 1)
			{
				this._folderDrag.removeItems($source.parent());
			}

			if (this._assetDrag)
			{
				this._assetDrag.updateDropTargets();
			}
		}
	},

	_getSourceLevel: function($source)
	{
		return $source.parentsUntil('nav', 'ul').length;
	},

	/**
	 * Initialize the index page-specific features
	 */
	_initIndexPageMode: function()
	{
		// Make the elements selectable
		this.settings.selectable = true;
		this.settings.multiSelect = true;

		var onDragStartProxy = $.proxy(this, '_onDragStart'),
			onDropTargetChangeProxy = $.proxy(this, '_onDropTargetChange');

		// Asset dragging
		// ---------------------------------------------------------------------

		this._assetDrag = new Garnish.DragDrop({
			activeDropTargetClass: 'sel',
			helperOpacity: 0.75,

			filter: $.proxy(function()
			{
				return this.view.getSelectedElements();
			}, this),

			helper: $.proxy(function($file)
			{
				return this._getFileDragHelper($file);
			}, this),

			dropTargets: $.proxy(function()
			{
				var targets = [];

				for (var i = 0; i < this.$sources.length; i++)
				{
					// Make sure it's a volume folder
					var $source = this.$sources.eq(i);
					if (this._getFolderIdFromSourceKey($source.data('key'))) {
						targets.push($source);
					}
				}

				return targets;
			}, this),

			onDragStart: onDragStartProxy,
			onDropTargetChange: onDropTargetChangeProxy,
			onDragStop: $.proxy(this, '_onFileDragStop')
		});

		// Folder dragging
		// ---------------------------------------------------------------------

		this._folderDrag = new Garnish.DragDrop(
		{
			activeDropTargetClass: 'sel',
			helperOpacity: 0.75,

			filter: $.proxy(function()
			{
				// Return each of the selected <a>'s parent <li>s, except for top level drag attempts.
				var $selected = this.sourceSelect.getSelectedItems(),
					draggees = [];

				for (var i = 0; i < $selected.length; i++)
				{
					var $source = $($selected[i]).parent();

					if ($source.hasClass('sel') && this._getSourceLevel($source) > 1)
					{
						draggees.push($source[0]);
					}
				}

				return $(draggees);
			}, this),

			helper: $.proxy(function($draggeeHelper)
			{
				var $helperSidebar = $('<div class="sidebar" style="padding-top: 0; padding-bottom: 0;"/>'),
					$helperNav = $('<nav/>').appendTo($helperSidebar),
					$helperUl = $('<ul/>').appendTo($helperNav);

				$draggeeHelper.appendTo($helperUl).removeClass('expanded');
				$draggeeHelper.children('a').addClass('sel');

				// Match the style
				$draggeeHelper.css({
					'padding-top':    this._folderDrag.$draggee.css('padding-top'),
					'padding-right':  this._folderDrag.$draggee.css('padding-right'),
					'padding-bottom': this._folderDrag.$draggee.css('padding-bottom'),
					'padding-left':   this._folderDrag.$draggee.css('padding-left')
				});

				return $helperSidebar;
			}, this),

			dropTargets: $.proxy(function()
			{
				var targets = [];

				// Tag the dragged folder and it's subfolders
				var draggedSourceIds = [];
				this._folderDrag.$draggee.find('a[data-key]').each(function()
				{
					draggedSourceIds.push($(this).data('key'));
				});

				for (var i = 0; i < this.$sources.length; i++)
				{
					// Make sure it's a volume folder and not one of the dragged folders
					var $source = this.$sources.eq(i),
						key = $source.data('key');

					if (this._getFolderIdFromSourceKey(key) && !Craft.inArray(key, draggedSourceIds)) {
						targets.push($source);
					}
				}

				return targets;
			}, this),

			onDragStart: onDragStartProxy,
			onDropTargetChange: onDropTargetChangeProxy,
			onDragStop: $.proxy(this, '_onFolderDragStop')
		});
	},

	/**
	 * On file drag stop
	 */
	_onFileDragStop: function()
	{
		if (this._assetDrag.$activeDropTarget && this._assetDrag.$activeDropTarget[0] != this.$source[0])
		{
			// Keep it selected
			var originatingSource = this.$source;

			var targetFolderId = this._getFolderIdFromSourceKey(this._assetDrag.$activeDropTarget.data('key')),
				originalAssetIds = [];

			// For each file, prepare array data.
			for (var i = 0; i < this._assetDrag.$draggee.length; i++)
			{
				var originalAssetId = Craft.getElementInfo(this._assetDrag.$draggee[i]).id;

				originalAssetIds.push(originalAssetId);
			}

			// Are any files actually getting moved?
			if (originalAssetIds.length)
			{
				this.setIndexBusy();

				this._positionProgressBar();
				this.progressBar.resetProgressBar();
				this.progressBar.setItemCount(originalAssetIds.length);
				this.progressBar.showProgressBar();


				// For each file to move a separate request
				var parameterArray = [];
				for (i = 0; i < originalAssetIds.length; i++)
				{
					parameterArray.push({
						assetId: originalAssetIds[i],
						folderId: targetFolderId
					});
				}

				// Define the callback for when all file moves are complete
				var onMoveFinish = $.proxy(function(responseArray)
				{
					this.promptHandler.resetPrompts();

					// Loop trough all the responses
					for (var i = 0; i < responseArray.length; i++)
					{
						var response = responseArray[i];

						// Push prompt into prompt array
						if (response.prompt)
						{
							var promptData = {
								message: this._fileConflictTemplate.message,
								choices: this._fileConflictTemplate.choices
							};
							promptData.message = Craft.t('app', promptData.message, {file: response.filename});
							response.prompt = promptData;

							this.promptHandler.addPrompt(response);
						}

						if (response.error)
						{
							alert(response.error);
						}
					}

					this.setIndexAvailable();
					this.progressBar.hideProgressBar();
					var reloadIndex = false;

					var performAfterMoveActions = function ()
					{
						// Select original source
						this.sourceSelect.selectItem(originatingSource);

						// Make sure we use the correct offset when fetching the next page
						this._totalVisible -= this._assetDrag.$draggee.length;

						// And remove the elements that have been moved away
						for (var i = 0; i < originalAssetIds.length; i++)
						{
							$('[data-id=' + originalAssetIds[i] + ']').remove();
						}

						this.view.deselectAllElements();
						this._collapseExtraExpandedFolders(targetFolderId);

						if (reloadIndex)
						{
							this.updateElements();
						}
					};

					if (this.promptHandler.getPromptCount())
					{
						// Define callback for completing all prompts
						var promptCallback = $.proxy(function(returnData)
						{
							var newParameterArray = [];

							// Loop trough all returned data and prepare a new request array
							for (var i = 0; i < returnData.length; i++)
							{
								if (returnData[i].choice == 'cancel')
								{
									reloadIndex = true;
									continue;
								}

								// Find the matching request parameters for this file and modify them slightly
								for (var ii = 0; ii < parameterArray.length; ii++)
								{
									if (parameterArray[ii].assetId == returnData[i].assetId)
									{
										parameterArray[ii].userResponse = returnData[i].choice;
										newParameterArray.push(parameterArray[ii]);
									}
								}
							}

							// Nothing to do, carry on
							if (newParameterArray.length == 0)
							{
								performAfterMoveActions.apply(this);
							}
							else
							{
								// Start working
								this.setIndexBusy();
								this.progressBar.resetProgressBar();
								this.progressBar.setItemCount(this.promptHandler.getPromptCount());
								this.progressBar.showProgressBar();

								// Move conflicting files again with resolutions now
								this._moveFile(newParameterArray, 0, onMoveFinish);
							}
						}, this);

						this._assetDrag.fadeOutHelpers();
						this.promptHandler.showBatchPrompts(promptCallback);
					}
					else
					{
						performAfterMoveActions.apply(this);
						this._assetDrag.fadeOutHelpers();
					}
				}, this);

				// Initiate the file move with the built array, index of 0 and callback to use when done
				this._moveFile(parameterArray, 0, onMoveFinish);

				// Skip returning dragees
				return;
			}
		}
		else
		{
			// Add the .sel class back on the selected source
			this.$source.addClass('sel');

			this._collapseExtraExpandedFolders();
		}

		this._assetDrag.returnHelpersToDraggees();
	},

	/**
	 * On folder drag stop
	 */
	_onFolderDragStop: function()
	{
		// Only move if we have a valid target and we're not trying to move into our direct parent
		if (
			this._folderDrag.$activeDropTarget &&
			this._folderDrag.$activeDropTarget.siblings('ul').children('li').filter(this._folderDrag.$draggee).length == 0
		)
		{
			var targetFolderId = this._getFolderIdFromSourceKey(this._folderDrag.$activeDropTarget.data('key'));

			this._collapseExtraExpandedFolders(targetFolderId);

			// Get the old folder IDs, and sort them so that we're moving the most-nested folders first
			var folderIds = [];

			for (var i = 0; i < this._folderDrag.$draggee.length; i++)
			{
				var $a = this._folderDrag.$draggee.eq(i).children('a'),
					folderId = this._getFolderIdFromSourceKey($a.data('key')),
					$source = this._getSourceByFolderId(folderId);

				// Make sure it's not already in the target folder
				if (this._getFolderIdFromSourceKey(this._getParentSource($source).data('key')) != targetFolderId)
				{
					folderIds.push(folderId);
				}
			}

			if (folderIds.length)
			{
				folderIds.sort();
				folderIds.reverse();

				this.setIndexBusy();
				this._positionProgressBar();
				this.progressBar.resetProgressBar();
				this.progressBar.setItemCount(folderIds.length);
				this.progressBar.showProgressBar();

				var responseArray = [];
				var parameterArray = [];

				for (var i = 0; i < folderIds.length; i++)
				{
					parameterArray.push({
						folderId: folderIds[i],
						parentId: targetFolderId
					});
				}

				// Increment, so to avoid displaying folder files that are being moved
				this.requestId++;

				/*
				 Here's the rundown:
				 1) Send all the folders being moved
				 2) Get results:
				   a) For all conflicting, receive prompts and resolve them to get:
				   b) For all valid move operations: by now server has created the needed folders
					  in target destination. Server returns an array of file move operations
				   c) server also returns a list of all the folder id changes
				   d) and the data-id of node to be removed, in case of conflict
				   e) and a list of folders to delete after the move
				 3) From data in 2) build a large file move operation array
				 4) Create a request loop based on this, so we can display progress bar
				 5) when done, delete all the folders and perform other maintenance
				 6) Champagne
				 */

				// This will hold the final list of files to move
				var fileMoveList = [];

				// These folders have to be deleted at the end
				var folderDeleteList = [];

				// This one tracks the changed folder ids
				var changedFolderIds = {};

				var removeFromTree = [];

				var onMoveFinish = $.proxy(function(responseArray)
				{
					this.promptHandler.resetPrompts();

					// Loop trough all the responses
					for (var i = 0; i < responseArray.length; i++)
					{
						var data = responseArray[i];

						// If succesful and have data, then update
						if (data.success)
						{
							// TODO REFACTOR THIS OUT
							if (data.transferList && data.changedIds)
							{
								for (var ii = 0; ii < data.transferList.length; ii++)
								{
									fileMoveList.push(data.transferList[ii]);
								}

								folderDeleteList = folderIds;

								for (var oldFolderId in data.changedIds)
								{
									if (!data.changedIds.hasOwnProperty(oldFolderId)) {
										continue;
									}

									changedFolderIds[oldFolderId] = data.changedIds[oldFolderId];
								}

								removeFromTree.push(data.removeFromTree);
							}
						}

						// Push prompt into prompt array
						if (data.prompt)
						{
							var promptData = {
								message: this._folderConflictTemplate.message,
								choices: this._folderConflictTemplate.choices
							};

							promptData.message = Craft.t('app', promptData.message, {folder: data.foldername});
							data.prompt = promptData;

							this.promptHandler.addPrompt(data);
						}

						if (data.error)
						{
							alert(data.error);
						}
					}

					if (this.promptHandler.getPromptCount())
					{
						// Define callback for completing all prompts
						var promptCallback = $.proxy(function(returnData)
						{
							this.promptHandler.resetPrompts();

							var newParameterArray = [];

							// Loop trough all returned data and prepare a new request array
							for (var i = 0; i < returnData.length; i++)
							{
								if (returnData[i].choice == 'cancel')
								{
									continue;
								}

								parameterArray[0].userResponse = returnData[i].choice;
								newParameterArray.push(parameterArray[0]);
							}

							// Start working on them lists, baby
							if (newParameterArray.length == 0)
							{
								$.proxy(this, '_performActualFolderMove', fileMoveList, folderDeleteList, changedFolderIds, removeFromTree)();
							}
							else
							{
								// Start working
								this.setIndexBusy();
								this.progressBar.resetProgressBar();
								this.progressBar.setItemCount(this.promptHandler.getPromptCount());
								this.progressBar.showProgressBar();

								// Move conflicting files again with resolutions now
								moveFolder(newParameterArray, 0, onMoveFinish);
							}
						}, this);

						this.promptHandler.showBatchPrompts(promptCallback);

						this.setIndexAvailable();
						this.progressBar.hideProgressBar();
					}
					else
					{
						$.proxy(this, '_performActualFolderMove', fileMoveList, folderDeleteList, changedFolderIds, removeFromTree, targetFolderId)();
					}
				}, this);

				var moveFolder = $.proxy(function(parameterArray, parameterIndex, callback)
				{
					if (parameterIndex == 0)
					{
						responseArray = [];
					}

					Craft.postActionRequest('assets/move-folder', parameterArray[parameterIndex], $.proxy(function(data, textStatus)
					{
						parameterIndex++;
						this.progressBar.incrementProcessedItemCount(1);
						this.progressBar.updateProgressBar();

						if (textStatus == 'success')
						{
							responseArray.push(data);
						}

						if (parameterIndex >= parameterArray.length)
						{
							callback(responseArray);
						}
						else
						{
							moveFolder(parameterArray, parameterIndex, callback);
						}
					}, this));
				}, this);

				// Initiate the folder move with the built array, index of 0 and callback to use when done
				moveFolder(parameterArray, 0, onMoveFinish);

				// Skip returning dragees until we get the Ajax response
				return;
			}
		}
		else
		{
			// Add the .sel class back on the selected source
			this.$source.addClass('sel');

			this._collapseExtraExpandedFolders();
		}

		this._folderDrag.returnHelpersToDraggees();
	},

	/**
	 * Really move the folder. Like really. For real.
	 */
	_performActualFolderMove: function(fileMoveList, folderDeleteList, changedFolderIds, removeFromTree, targetFolderId)
	{
		this.setIndexBusy();
		this.progressBar.resetProgressBar();
		this.progressBar.setItemCount(1);
		this.progressBar.showProgressBar();

		var moveCallback = $.proxy(function(folderDeleteList, changedFolderIds, removeFromTree)
		{
			//Move the folders around in the tree
			var topFolderLi = $();
			var folderToMove = $();
			var topFolderMovedId = 0;

			// Change the folder ids
			for (var previousFolderId in changedFolderIds)
			{
				if (!changedFolderIds.hasOwnProperty(previousFolderId)) {
					continue;
				}

				folderToMove = this._getSourceByFolderId(previousFolderId);

				// Change the id and select the containing element as the folder element.
				folderToMove = folderToMove
									.attr('data-key', 'folder:' + changedFolderIds[previousFolderId])
									.data('key', 'folder:' + changedFolderIds[previousFolderId]).parent();

				if (topFolderLi.length == 0 || topFolderLi.parents().filter(folderToMove).length > 0)
				{
					topFolderLi = folderToMove;
					topFolderMovedId = changedFolderIds[previousFolderId];
				}
			}

			if (topFolderLi.length == 0)
			{
				this.setIndexAvailable();
				this.progressBar.hideProgressBar();
				this._folderDrag.returnHelpersToDraggees();

				return;
			}

			var topFolder = topFolderLi.children('a');

			// Now move the uppermost node.
			var siblings = topFolderLi.siblings('ul, .toggle');
			var parentSource = this._getParentSource(topFolder);

			var $newParent = this._getSourceByFolderId(targetFolderId);

			if (typeof removeFromTree != "undefined")
			{
				for (var i = 0; i < removeFromTree.length; i++)
				{
					$newParent.parent().find('[data-key="folder:' + removeFromTree[i] + '"]').parent().remove();
				}
			}
			this._prepareParentForChildren($newParent);
			this._appendSubfolder($newParent, topFolderLi);

			topFolder.after(siblings);

			this._cleanUpTree(parentSource);
			this._cleanUpTree($newParent);
			this.$sidebar.find('ul>ul, ul>.toggle').remove();

			// Delete the old folders
			for (var i = 0; i < folderDeleteList.length; i++)
			{
				Craft.postActionRequest('assets/delete-folder', {folderId: folderDeleteList[i]});
			}

			this.setIndexAvailable();
			this.progressBar.hideProgressBar();
			this._folderDrag.returnHelpersToDraggees();

			this._selectSourceByFolderId(topFolderMovedId);

		}, this);

		if (fileMoveList.length > 0)
		{
			this._moveFile(fileMoveList, 0, $.proxy(function()
			{
				moveCallback(folderDeleteList, changedFolderIds, removeFromTree);
			}, this));
		}
		else
		{
			moveCallback(folderDeleteList, changedFolderIds, removeFromTree);
		}
	},

	/**
	 * Get parent source for a source.
	 *
	 * @param $source
	 * @returns {*}
	 * @private
	 */
	_getParentSource: function($source)
	{
		if (this._getSourceLevel($source) > 1)
		{
			return $source.parent().parent().siblings('a');
		}
	},

	/**
	 * Move a file using data from a parameter array.
	 *
	 * @param parameterArray
	 * @param parameterIndex
	 * @param callback
	 * @private
	 */
	_moveFile: function(parameterArray, parameterIndex, callback)
	{
		if (parameterIndex == 0)
		{
			this.responseArray = [];
		}

		Craft.postActionRequest('assets/move-asset', parameterArray[parameterIndex], $.proxy(function(data, textStatus)
		{
			this.progressBar.incrementProcessedItemCount(1);
			this.progressBar.updateProgressBar();

			if (textStatus == 'success')
			{
				this.responseArray.push(data);

				// If assets were just merged we should get the referece tags updated right away
				Craft.cp.runPendingTasks();
			}

			parameterIndex++;

			if (parameterIndex >= parameterArray.length)
			{
				callback(this.responseArray);
			}
			else
			{
				this._moveFile(parameterArray, parameterIndex, callback);
			}

		}, this));
	},

	_selectSourceByFolderId: function(targetFolderId)
	{
		var $targetSource = this._getSourceByFolderId(targetFolderId);

		// Make sure that all the parent sources are expanded and this source is visible.
		var $parentSources = $targetSource.parent().parents('li');

		for (var i = 0; i < $parentSources.length; i++)
		{
			var $parentSource = $($parentSources[i]);

			if (!$parentSource.hasClass('expanded'))
			{
				$parentSource.children('.toggle').click();
			}
		}

		this.sourceSelect.selectItem($targetSource);

		this.$source = $targetSource;
		this.sourceKey = $targetSource.data('key');
		this.setInstanceState('selectedSource', this.sourceKey);

		this.updateElements();
	},

	/**
	 * Initialize the uploader.
	 *
	 * @private
	 */
	afterInit: function()
	{
		if (!this.$uploadButton)
		{
			this.$uploadButton = $('<div class="btn submit" data-icon="upload" style="position: relative; overflow: hidden;" role="button">' + Craft.t('app', 'Upload files') + '</div>');
			this.addButton(this.$uploadButton);

			this.$uploadInput = $('<input type="file" multiple="multiple" name="assets-upload" />').hide().insertBefore(this.$uploadButton);
		}

		this.promptHandler = new Craft.PromptHandler();
		this.progressBar = new Craft.ProgressBar(this.$main, true);

		var options = {
			url: Craft.getActionUrl('assets/save-asset'),
			fileInput: this.$uploadInput,
			dropZone: this.$main
		};

		options.events = {
			fileuploadstart:       $.proxy(this, '_onUploadStart'),
			fileuploadprogressall: $.proxy(this, '_onUploadProgress'),
			fileuploaddone:        $.proxy(this, '_onUploadComplete')
		};

		if (typeof this.settings.criteria.kind != "undefined")
		{
			options.allowedKinds = this.settings.criteria.kind;
		}

		this._currentUploaderSettings = options;

		this.uploader = new Craft.Uploader(this.$uploadButton, options);

		this.$uploadButton.on('click', $.proxy(function()
		{
			if (this.$uploadButton.hasClass('disabled'))
			{
				return;
			}
			if (!this.isIndexBusy)
			{
				this.$uploadButton.parent().find('input[name=assets-upload]').click();
			}
		}, this));

		this.base();
	},

	onSelectSource: function()
	{
		var folderId = this._getFolderIdFromSourceKey(this.sourceKey);

		if (folderId && this.$source.attr('data-upload')) {
			this.uploader.setParams({
				folderId: folderId
			});
			this.$uploadButton.removeClass('disabled');
		} else {
			this.$uploadButton.addClass('disabled');
		}

		this.base();
	},

	_getFolderIdFromSourceKey: function(sourceKey)
	{
		var m = sourceKey.match(/\bfolder:(\d+)$/);

		return m ? m[1] : null;
	},

	startSearching: function()
	{
		// Does this source have subfolders?
		if (this.$source.siblings('ul').length)
		{
			if (this.$includeSubfoldersContainer === null)
			{
				var id = 'includeSubfolders-'+Math.floor(Math.random()*1000000000);

				this.$includeSubfoldersContainer = $('<div style="margin-bottom: -23px; opacity: 0;"/>').insertAfter(this.$search);
				var $subContainer = $('<div style="padding-top: 5px;"/>').appendTo(this.$includeSubfoldersContainer);
				this.$includeSubfoldersCheckbox = $('<input type="checkbox" id="'+id+'" class="checkbox"/>').appendTo($subContainer);
				$('<label class="light smalltext" for="'+id+'"/>').text(' '+Craft.t('app', 'Search in subfolders')).appendTo($subContainer);

				this.addListener(this.$includeSubfoldersCheckbox, 'change', function()
				{
					this.setSelecetedSourceState('includeSubfolders', this.$includeSubfoldersCheckbox.prop('checked'));
					this.updateElements();
				});
			}
			else
			{
				this.$includeSubfoldersContainer.velocity('stop');
			}

			var checked = this.getSelectedSourceState('includeSubfolders', false);
			this.$includeSubfoldersCheckbox.prop('checked', checked);

			this.$includeSubfoldersContainer.velocity({
				marginBottom: 0,
				opacity: 1
			}, 'fast');

			this.showingIncludeSubfoldersCheckbox = true;
		}

		this.base();
	},

	stopSearching: function()
	{
		if (this.showingIncludeSubfoldersCheckbox)
		{
			this.$includeSubfoldersContainer.velocity('stop');

			this.$includeSubfoldersContainer.velocity({
				marginBottom: -23,
				opacity: 0
			}, 'fast');

			this.showingIncludeSubfoldersCheckbox = false;
		}

		this.base();
	},

	getViewParams: function()
	{
		var data = this.base();

		if (this.showingIncludeSubfoldersCheckbox && this.$includeSubfoldersCheckbox.prop('checked'))
		{
			data.criteria.includeSubfolders = true;
		}

		return data;
	},

	/**
	 * React on upload submit.
	 *
	 * @param {object} event
	 * @private
     */
	_onUploadStart: function(event)
	{
		this.setIndexBusy();

		// Initial values
		this._positionProgressBar();
		this.progressBar.resetProgressBar();
		this.progressBar.showProgressBar();

		this.promptHandler.resetPrompts();
	},

	/**
	 * Update uploaded byte count.
	 */
	_onUploadProgress: function(event, data)
	{
		var progress = parseInt(data.loaded / data.total * 100, 10);
		this.progressBar.setProgressPercentage(progress);
	},

	/**
	 * On Upload Complete.
	 */
	_onUploadComplete: function(event, data)
	{
		var response = data.result;
		var filename = data.files[0].name;

		var doReload = true;

		if (response.success || response.prompt)
		{
			// Add the uploaded file to the selected ones, if appropriate
			this._uploadedAssetIds.push(response.assetId);

			// If there is a prompt, add it to the queue
			if (response.prompt)
			{
				var promptData = {
					message: this._fileConflictTemplate.message,
					choices: this._fileConflictTemplate.choices
				};
				promptData.message = Craft.t('app', promptData.message, {file: response.filename});
				response.prompt = promptData;

				this.promptHandler.addPrompt(response);
			}
		}
		else
		{
			if (response.error)
			{
				alert(Craft.t('app', 'Upload failed. The error message was: “{error}”', {error: response.error }));
			}
			else
			{
				alert(Craft.t('app', 'Upload failed for {filename}.', { filename: filename }));
			}

			doReload = false;
		}

		// For the last file, display prompts, if any. If not - just update the element view.
		if (this.uploader.isLastUpload())
		{
			this.setIndexAvailable();
			this.progressBar.hideProgressBar();

			if (this.promptHandler.getPromptCount())
			{
				this.promptHandler.showBatchPrompts($.proxy(this, '_uploadFollowup'));
			}
			else
			{
				if (doReload)
				{
					this.updateElements();
				}
			}
		}
	},

	/**
	 * Follow up to an upload that triggered at least one conflict resolution prompt.
	 *
	 * @param returnData
	 * @private
	 */
	_uploadFollowup: function(returnData)
	{
		this.setIndexBusy();
		this.progressBar.resetProgressBar();

		this.promptHandler.resetPrompts();

		var finalCallback = $.proxy(function()
		{
			this.setIndexAvailable();
			this.progressBar.hideProgressBar();
			this.updateElements();
		}, this);

		this.progressBar.setItemCount(returnData.length);

		var doFollowup = $.proxy(function(parameterArray, parameterIndex, callback)
		{
			var postData = {
				assetId:       parameterArray[parameterIndex].assetId,
				filename:     parameterArray[parameterIndex].filename,
				userResponse: parameterArray[parameterIndex].choice
			};

			Craft.postActionRequest('assets/save-asset', postData, $.proxy(function(data, textStatus)
			{
				if (textStatus == 'success' && data.assetId)
				{
					this._uploadedAssetIds.push(data.assetId);
				}
				parameterIndex++;
				this.progressBar.incrementProcessedItemCount(1);
				this.progressBar.updateProgressBar();

				if (parameterIndex == parameterArray.length)
				{
					callback();
				}
				else
				{
					doFollowup(parameterArray, parameterIndex, callback);
				}
			}, this));

		}, this);

		this.progressBar.showProgressBar();
		doFollowup(returnData, 0, finalCallback);
	},

	/**
	 * Perform actions after updating elements
	 * @private
	 */
	onUpdateElements: function()
	{
		this._onUpdateElements(false, this.view.getAllElements());
		this.view.on('appendElements', $.proxy(function(ev) {
			this._onUpdateElements(true, ev.newElements);
		}, this));

		this.base();
	},

	_onUpdateElements: function(append, $newElements)
	{
		if (this.settings.context == 'index')
		{
			if (!append)
			{
				this._assetDrag.removeAllItems();
			}

			this._assetDrag.addItems($newElements);
		}

		// See if we have freshly uploaded files to add to selection
		if (this._uploadedAssetIds.length)
		{
			if (this.view.settings.selectable)
			{
				for (var i = 0; i < this._uploadedAssetIds.length; i++)
				{
					this.view.selectElementById(this._uploadedAssetIds[i]);
				}
			}

			// Reset the list.
			this._uploadedAssetIds = [];
		}

		this.base(append, $newElements);
	},

	/**
	 * On Drag Start
	 */
	_onDragStart: function()
	{
		this._tempExpandedFolders = [];
	},

	/**
	 * Get File Drag Helper
	 */
	_getFileDragHelper: function($element)
	{
		var currentView = this.getSelectedSourceState('mode');

		switch (currentView)
		{
			case 'table':
			{
				var $outerContainer = $('<div class="elements datatablesorthelper"/>').appendTo(Garnish.$bod),
					$innerContainer = $('<div class="tableview"/>').appendTo($outerContainer),
					$table = $('<table class="data"/>').appendTo($innerContainer),
					$tbody = $('<tbody/>').appendTo($table);

				$element.appendTo($tbody);

				// Copy the column widths
				this._$firstRowCells = this.view.$table.children('tbody').children('tr:first').children();
				var $helperCells = $element.children();

				for (var i = 0; i < $helperCells.length; i++)
				{
					// Hard-set the cell widths
					var $helperCell = $($helperCells[i]);

					// Skip the checkbox cell
					if ($helperCell.hasClass('checkbox-cell'))
					{
						$helperCell.remove();
						$outerContainer.css('margin-'+Craft.left, 19); // 26 - 7
						continue;
					}

					var $firstRowCell = $(this._$firstRowCells[i]),
						width = $firstRowCell.width();

					$firstRowCell.width(width);
					$helperCell.width(width);
				}

				return $outerContainer;
			}
			case 'thumbs':
			{
				var $outerContainer = $('<div class="elements thumbviewhelper"/>').appendTo(Garnish.$bod),
					$innerContainer = $('<ul class="thumbsview"/>').appendTo($outerContainer);

				$element.appendTo($innerContainer);

				return $outerContainer;
			}
		}

		return $();
	},

	/**
	 * On Drop Target Change
	 */
	_onDropTargetChange: function($dropTarget)
	{
		clearTimeout(this._expandDropTargetFolderTimeout);

		if ($dropTarget)
		{
			var folderId = this._getFolderIdFromSourceKey($dropTarget.data('key'));

			if (folderId)
			{
				this.dropTargetFolder = this._getSourceByFolderId(folderId);

				if (this._hasSubfolders(this.dropTargetFolder) && ! this._isExpanded(this.dropTargetFolder))
				{
					this._expandDropTargetFolderTimeout = setTimeout($.proxy(this, '_expandFolder'), 500);
				}
			}
			else
			{
				this.dropTargetFolder = null;
			}
		}

		if ($dropTarget && $dropTarget[0] != this.$source[0])
		{
			// Temporarily remove the .sel class on the active source
			this.$source.removeClass('sel');
		}
		else
		{
			this.$source.addClass('sel');
		}
	},

	/**
	 * Collapse Extra Expanded Folders
	 */
	_collapseExtraExpandedFolders: function(dropTargetFolderId)
	{
		clearTimeout(this._expandDropTargetFolderTimeout);

		// If a source ID is passed in, exclude its parents
		var excluded;

		if (dropTargetFolderId)
		{
			excluded = this._getSourceByFolderId(dropTargetFolderId).parents('li').children('a');
		}

		for (var i = this._tempExpandedFolders.length-1; i >= 0; i--)
		{
			var $source = this._tempExpandedFolders[i];

			// Check the parent list, if a source id is passed in
			if (!dropTargetFolderId || excluded.filter('[data-key="' + $source.data('key') + '"]').length == 0)
			{
				this._collapseFolder($source);
				this._tempExpandedFolders.splice(i, 1);
			}
		}
	},

	_getSourceByFolderId: function(folderId)
	{
		return this.$sources.filter('[data-key$="folder:' + folderId + '"]');
	},

	_hasSubfolders: function($source)
	{
		return $source.siblings('ul').find('li').length;
	},

	_isExpanded: function($source)
	{
		return $source.parent('li').hasClass('expanded');
	},

	_expandFolder: function()
	{
		// Collapse any temp-expanded drop targets that aren't parents of this one
		this._collapseExtraExpandedFolders(this._getFolderIdFromSourceKey(this.dropTargetFolder.data('key')));

		this.dropTargetFolder.siblings('.toggle').click();

		// Keep a record of that
		this._tempExpandedFolders.push(this.dropTargetFolder);
	},

	_collapseFolder: function($source)
	{
		if ($source.parent().hasClass('expanded'))
		{
			$source.siblings('.toggle').click();
		}
	},

	_createFolderContextMenu: function($source)
	{
		var menuOptions = [{ label: Craft.t('app', 'New subfolder'), onClick: $.proxy(this, '_createSubfolder', $source) }];

		// For all folders that are not top folders
		if (this.settings.context == 'index' && this._getSourceLevel($source) > 1)
		{
			menuOptions.push({ label: Craft.t('app', 'Rename folder'), onClick: $.proxy(this, '_renameFolder', $source) });
			menuOptions.push({ label: Craft.t('app', 'Delete folder'), onClick: $.proxy(this, '_deleteFolder', $source) });
		}

		new Garnish.ContextMenu($source, menuOptions, {menuClass: 'menu'});
	},

	_createSubfolder: function($parentFolder)
	{
		var subfolderName = prompt(Craft.t('app', 'Enter the name of the folder'));

		if (subfolderName)
		{
			var params = {
				parentId:  this._getFolderIdFromSourceKey($parentFolder.data('key')),
				folderName: subfolderName
			};

			this.setIndexBusy();

			Craft.postActionRequest('assets/create-folder', params, $.proxy(function(data, textStatus)
			{
				this.setIndexAvailable();

				if (textStatus == 'success' && data.success)
				{
					this._prepareParentForChildren($parentFolder);

					var $subfolder = $(
						'<li>' +
							'<a data-key="folder:'+data.folderId+'"' +
								(Garnish.hasAttr($parentFolder, 'data-has-thumbs') ? ' data-has-thumbs' : '') +
								' data-upload="'+$parentFolder.attr('data-upload')+'"' +
							'>' +
								data.folderName +
							'</a>' +
						'</li>'
					);

					var $a = $subfolder.children('a:first');
					this._appendSubfolder($parentFolder, $subfolder);
					this.initSource($a);
				}

				if (textStatus == 'success' && data.error)
				{
					alert(data.error);
				}
			}, this));
		}
	},

	_deleteFolder: function($targetFolder)
	{
		if (confirm(Craft.t('app', 'Really delete folder “{folder}”?', {folder: $.trim($targetFolder.text())})))
		{
			var params = {
				folderId: this._getFolderIdFromSourceKey($targetFolder.data('key'))
			};

			this.setIndexBusy();

			Craft.postActionRequest('assets/delete-folder', params, $.proxy(function(data, textStatus)
			{
				this.setIndexAvailable();

				if (textStatus == 'success' && data.success)
				{
					var $parentFolder = this._getParentSource($targetFolder);

					// Remove folder and any trace from its parent, if needed
					this.deinitSource($targetFolder);

					$targetFolder.parent().remove();
					this._cleanUpTree($parentFolder);
				}

				if (textStatus == 'success' && data.error)
				{
					alert(data.error);
				}
			}, this));
		}
	},

	/**
	 * Rename
	 */
	_renameFolder: function($targetFolder)
	{
		var oldName = $.trim($targetFolder.text()),
			newName = prompt(Craft.t('app', 'Rename folder'), oldName);

		if (newName && newName != oldName)
		{
			var params = {
				folderId: this._getFolderIdFromSourceKey($targetFolder.data('key')),
				newName: newName
			};

			this.setIndexBusy();

			Craft.postActionRequest('assets/rename-folder', params, $.proxy(function(data, textStatus)
			{
				this.setIndexAvailable();

				if (textStatus == 'success' && data.success)
				{
					$targetFolder.text(data.newName);
				}

				if (textStatus == 'success' && data.error)
				{
					alert(data.error);
				}

			}, this), 'json');
		}
	},

	/**
	 * Prepare a source folder for children folder.
	 *
	 * @param $parentFolder
	 * @private
	 */
	_prepareParentForChildren: function($parentFolder)
	{
		if (!this._hasSubfolders($parentFolder))
		{
			$parentFolder.parent().addClass('expanded').append('<div class="toggle"></div><ul></ul>');
			this.initSourceToggle($parentFolder);
		}
	},

	/**
	 * Appends a subfolder to the parent folder at the correct spot.
	 *
	 * @param $parentFolder
	 * @param $subfolder
	 * @private
	 */
	_appendSubfolder: function($parentFolder, $subfolder)
	{
		var $subfolderList = $parentFolder.siblings('ul'),
			$existingChildren = $subfolderList.children('li'),
			subfolderLabel = $.trim($subfolder.children('a:first').text()),
			folderInserted = false;

		for (var i = 0; i < $existingChildren.length; i++)
		{
			var $existingChild = $($existingChildren[i]);

			if ($.trim($existingChild.children('a:first').text()) > subfolderLabel)
			{
				$existingChild.before($subfolder);
				folderInserted = true;
				break;
			}
		}

		if (!folderInserted)
		{
			$parentFolder.siblings('ul').append($subfolder);
		}
	},

	_cleanUpTree: function($parentFolder)
	{
		if ($parentFolder !== null && $parentFolder.siblings('ul').children('li').length == 0)
		{
			this.deinitSourceToggle($parentFolder);
			$parentFolder.siblings('ul').remove();
			$parentFolder.siblings('.toggle').remove();
			$parentFolder.parent().removeClass('expanded');
		}
	},

	_positionProgressBar: function()
	{
		var $container = $(),
			offset = 0;

		if (this.settings.context == 'index')
		{
			$container = this.progressBar.$progressBar.closest('#content');
		}
		else
		{
			$container = this.progressBar.$progressBar.closest('.main');
		}

		var containerTop = $container.offset().top;
		var scrollTop = Garnish.$doc.scrollTop();
		var diff = scrollTop - containerTop;
		var windowHeight = Garnish.$win.height();

		if ($container.height() > windowHeight)
		{
			offset = (windowHeight / 2) - 6 + diff;
		}
		else
		{
			offset = ($container.height() / 2) - 6;
		}

		this.progressBar.$progressBar.css({
			top: offset
		});
	}

});

// Register it!
Craft.registerElementIndexClass('craft\\app\\elements\\Asset', Craft.AssetIndex);
