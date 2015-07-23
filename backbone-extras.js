// Backbone Extras
(function (factory) {

  // Start with AMD.
  if (typeof define === 'function' && define.amd) {
    define(['underscore', 'backbone', 'exports'], factory);
  }

  // Next for Node.js or CommonJS.
  else if (typeof exports === 'object') {
    factory(require('underscore'), require('backbone'), exports);
  }

  // Finally, as a browser global.
  else {
    factory(_, Backbone, {});
  }

}(function (_, Backbone, BackboneExtras) {

    /**
     * Constructor
     * @constructor
     */
    var _delayedTriggers = [],
        nestedChanges;

    BackboneExtras.Model = Backbone.Model.extend({
        /**
         * The options passed to the function
         * @type {Object}
         */
        options : {},
        /**
         * Merge a specified set of options from the passed options object with properties on this object.
         * @param {Object} options The options to pick from when merging.
         * @param {Array} mergeOpts The option names to merge.
         */
        mergeOpts: function (options, mergeOpts) {
            // Merge some passed options with default options
            _.extend(this, _.pick(_.extend({}, options), mergeOpts));
        },
        get: function(attrStrOrPath){
            var attrPath = UberBackbone.Model.attrPath(attrStrOrPath),
                result;

            UberBackbone.Model.walkPath(this.attributes, attrPath, function(val, path){
                var attr = _.last(path);
                if (path.length === attrPath.length){
                    // attribute found
                    result = val[attr];
                }
            });

            return result;
        },

        has: function(attr){
            // for some reason this is not how Backbone.Model is implemented - it accesses the attributes object directly
            var result = this.get(attr);
            return !(result === null || _.isUndefined(result));
        },

        set: function(key, value, opts){
            var newAttrs = UberBackbone.Model.deepClone(this.attributes),
                attrPath,
                unsetObj,
                validated;

            if (_.isString(key)){
                // Backbone 0.9.0+ syntax: `model.set(key, val)` - convert the key to an attribute path
                attrPath = UberBackbone.Model.attrPath(key);
            } else if (_.isArray(key)){
                // attribute path
                attrPath = key;
            }

            if (attrPath){
                opts = opts || {};
                this._setAttr(newAttrs, attrPath, value, opts);
            } else { // it's an Object
                opts = value || {};
                var attrs = key;
                for (var _attrStr in attrs) {
                    if (attrs.hasOwnProperty(_attrStr)) {
                        this._setAttr(newAttrs,
                                                    UberBackbone.Model.attrPath(_attrStr),
                                                    opts.unset ? void 0 : attrs[_attrStr],
                                                    opts);
                    }
                }
            }

            nestedChanges = UberBackbone.Model.__super__.changedAttributes.call(this);

            if (opts.unset && attrPath && attrPath.length === 1){ // assume it is a singular attribute being unset
                // unsetting top-level attribute
                unsetObj = {};
                unsetObj[key] = void 0;
                nestedChanges = _.omit(nestedChanges, _.keys(unsetObj));
                validated = UberBackbone.Model.__super__.set.call(this, unsetObj, opts);
            } else {
                unsetObj = newAttrs;

                // normal set(), or an unset of nested attribute
                if (opts.unset && attrPath){
                    // make sure Backbone.Model won't unset the top-level attribute
                    opts = _.extend({}, opts);
                    delete opts.unset;
                } else if (opts.unset && _.isObject(key)) {
                    unsetObj = key;
                }
                nestedChanges = _.omit(nestedChanges, _.keys(unsetObj));
                validated = UberBackbone.Model.__super__.set.call(this, unsetObj, opts);
            }


            if (!validated){
                // reset changed attributes
                this.changed = {};
                nestedChanges = {};
                return false;
            }


            this._runDelayedTriggers();
            return this;
        },

        unset: function(attr, options) {
            return this.set(attr, void 0, _.extend({}, options, {unset: true}));
        },

        clear: function(options) {
            nestedChanges = {};

            // Mostly taken from Backbone.Model.set, modified to work for NestedModel.
            options = options || {};
            // clone attributes so validate method can't mutate it from underneath us.
            var attrs = _.clone(this.attributes);
            if (!options.silent && this.validate && !this.validate(attrs, options)) {
                return false; // Should maybe return this instead?
            }

            var changed = this.changed = {};
            var model = this;

            var setChanged = function(obj, prefix, options) {
                // obj will be an Array or an Object
                _.each(obj, function(val, attr){
                    var changedPath = prefix;
                    if (_.isArray(obj)){
                        // assume there is a prefix
                        changedPath += '[' + attr + ']';
                    } else if (prefix){
                        changedPath += '>' + attr;
                    } else {
                        changedPath = attr;
                    }

                    val = obj[attr];
                    if (_.isObject(val)) { // clear child attrs
                        setChanged(val, changedPath, options);
                    }
                    if (!options.silent) model._delayedChange(changedPath, null, options);
                    changed[changedPath] = null;
                });
            };
            setChanged(this.attributes, '', options);

            this.attributes = {};

            // Fire the `"change"` events.
            if (!options.silent) this._delayedTrigger('change');

            this._runDelayedTriggers();
            return this;
        },

        add: function(attrStr, value, opts){
            var current = this.get(attrStr);
            if (!_.isArray(current)) throw new Error('current value is not an array');
            return this.set(attrStr + '[' + current.length + ']', value, opts);
        },

        remove: function(attrStr, opts){
            opts = opts || {};

            var attrPath = UberBackbone.Model.attrPath(attrStr),
                aryPath = _.initial(attrPath),
                val = this.get(aryPath),
                i = _.last(attrPath);

            if (!_.isArray(val)){
                throw new Error("remove() must be called on a nested array");
            }

            // only trigger if an element is actually being removed
            var trigger = !opts.silent && (val.length >= i + 1),
                oldEl = val[i];

            // remove the element from the array
            val.splice(i, 1);
            opts.silent = true; // Triggers should only be fired in trigger section below
            this.set(aryPath, val, opts);

            if (trigger){
                attrStr = UberBackbone.Model.createAttrStr(aryPath);
                this.trigger('remove:' + attrStr, this, oldEl);
                for (var aryCount = aryPath.length; aryCount >= 1; aryCount--) {
                    attrStr = UberBackbone.Model.createAttrStr(_.first(aryPath, aryCount));
                    this.trigger('change:' + attrStr, this, oldEl);
                }
                this.trigger('change', this, oldEl);
            }

            return this;
        },

        changedAttributes: function(diff) {
            var backboneChanged = UberBackbone.Model.__super__.changedAttributes.call(this, diff);
            if (_.isObject(backboneChanged)) {
                return _.extend({}, nestedChanges, backboneChanged);
            }
            return false;
        },

        toJSON: function(){
            return UberBackbone.Model.deepClone(this.attributes);
        },


        // private
        _delayedTrigger: function(/* the trigger args */){
            _delayedTriggers.push(arguments);
        },

        _delayedChange: function(attrStr, newVal, options){
            this._delayedTrigger('change:' + attrStr, this, newVal, options);

            // Check if `change` even *exists*, as it won't when the model is
            // freshly created.
            if (!this.changed) {
                this.changed = {};
            }

            this.changed[attrStr] = newVal;
        },

        _runDelayedTriggers: function(){
            while (_delayedTriggers.length > 0){
                this.trigger.apply(this, _delayedTriggers.shift());
            }
        },

        // note: modifies `newAttrs`
        _setAttr: function(newAttrs, attrPath, newValue, opts){
            opts = opts || {};

            var fullPathLength = attrPath.length;
            var model = this;

            UberBackbone.Model.walkPath(newAttrs, attrPath, function(val, path, next){
                var attr = _.last(path);
                var attrStr = UberBackbone.Model.createAttrStr(path);

                // See if this is a new value being set
                var isNewValue = !_.isEqual(val[attr], newValue);

                if (path.length === fullPathLength){
                    // reached the attribute to be set

                    if (opts.unset){
                        // unset the value
                        delete val[attr];

                        // Trigger Remove Event if array being set to null
                        if (_.isArray(val)){
                            var parentPath = UberBackbone.Model.createAttrStr(_.initial(attrPath));
                            model._delayedTrigger('remove:' + parentPath, model, val[attr]);
                        }
                    } else {
                        // Set the new value
                        val[attr] = newValue;
                    }

                    // Trigger Change Event if new values are being set
                    if (!opts.silent && _.isObject(newValue) && isNewValue){
                        var visited = [];
                        var checkChanges = function(obj, prefix) {
                            // Don't choke on circular references
                            if(_.indexOf(visited, obj) > -1) {
                                return;
                            } else {
                                visited.push(obj);
                            }

                            var nestedAttr, nestedVal;
                            for (var a in obj){
                                if (obj.hasOwnProperty(a)) {
                                    nestedAttr = prefix + '>' + a;
                                    nestedVal = obj[a];
                                    if (!_.isEqual(model.get(nestedAttr), nestedVal)) {
                                        model._delayedChange(nestedAttr, nestedVal, opts);
                                    }
                                    if (_.isObject(nestedVal)) {
                                        checkChanges(nestedVal, nestedAttr);
                                    }
                                }
                            }
                        };
                        checkChanges(newValue, attrStr);

                    }


                } else if (!val[attr]){
                    if (_.isNumber(next)){
                        val[attr] = [];
                    } else {
                        val[attr] = {};
                    }
                }

                if (!opts.silent){
                    // let the superclass handle change events for top-level attributes
                    if (path.length > 1 && isNewValue){
                        model._delayedChange(attrStr, val[attr], opts);
                    }

                    if (_.isArray(val[attr])){
                        model._delayedTrigger('add:' + attrStr, model, val[attr]);
                    }
                }
            });
        }

    }, {
        // class methods

        attrPath: function(attrStrOrPath){
            var path;

            if (_.isString(attrStrOrPath)){
                // TODO this parsing can probably be more efficient
                path = (attrStrOrPath === '') ? [''] : attrStrOrPath.match(/[^\>\[\]]+/g);
                path = _.map(path, function(val){
                    // convert array accessors to numbers
                    return val.match(/^\d+$/) ? parseInt(val, 10) : val;
                });
            } else {
                path = attrStrOrPath;
            }

            return path;
        },

        createAttrStr: function(attrPath){
            var attrStr = attrPath[0];
            _.each(_.rest(attrPath), function(attr){
                attrStr += _.isNumber(attr) ? ('[' + attr + ']') : ('>' + attr);
            });

            return attrStr;
        },

        deepClone: function(obj){
            return $.extend(true, {}, obj);
        },

        walkPath: function(obj, attrPath, callback, scope){
            var val = obj,
                childAttr;

            // walk through the child attributes
            for (var i = 0; i < attrPath.length; i++){
                callback.call(scope || this, val, attrPath.slice(0, i + 1), attrPath[i + 1]);

                childAttr = attrPath[i];
                val = val[childAttr];
                if (!val) break; // at the leaf
            }
        }

    });

    /**
     * Contructor
     * @constructor
     * @alias app/collections/base
     */
    BackboneExtras.Collection = Backbone.Collection.extend({
        /**
         * The options passed to the function
         * @type {Object}
         */
        options : {},
        /**
         * Sort direction
         * @type {String}
         */
        sortDir : 'asc',
        /**
         * Property of the model to sort by
         * @type {String}
         */
        sortName : 'asc',
        /**
         * Property of the model to sort by
         * @type {String}
         */
        query : {},
        /**
         * Automatically called upon object construction
         */
        initialize: function (models, options) {
            // Merge selected options into object
            this.mergeOpts(options, ['sortDir', 'sortName', 'query']);
        },
        /**
         * Merge a specified set of options from the passed options object with properties on this object.
         * @param {Object} options The options to pick from when merging.
         * @param {Array} mergeOpts The option names to merge.
         */
        mergeOpts: function (options, mergeOpts) {
            // Merge some passed options with default options
            _.extend(this, _.pick(_.extend({}, options), mergeOpts));
        },
        /**
         * The sort strategies availble for this collection
         * @param {String} dir The sort direction
         */
        strategies: function (dir) {
            if (dir === 'desc') {
                return function (prop) {
                    return function (model1, model2) {
                        // Convert prop values to lower-case strings so that we
                        // can do case-insensitive sorting
                        var prop1 = String(model1.get(prop)).toLowerCase();
                        var prop2 = String(model2.get(prop)).toLowerCase();

                        if (prop1 > prop2) return -1; // before
                        if (prop2 > prop1) return 1; // after
                        return 0; // equal
                    }
                }
            } else {
                return function (prop) {
                    return function (model1, model2) {
                        // Convert prop values to lower-case strings so that we
                        // can do case-insensitive sorting
                        var prop1 = String(model1.get(prop)).toLowerCase();
                        var prop2 = String(model2.get(prop)).toLowerCase();

                        if (prop1 > prop2) return 1; // after
                        if (prop1 < prop2) return -1; // before
                        return 0; // equal
                    }
                }
            }
        },
        /**
         * Change the sort comparator
         */
        setSort: function (dir, name, doSort) {
            // Toggle between asc and desc if no direction specified
            // and this is not our first sort on the particular property name
            // otherwise we just make the default 'asc' or whatever direction they passed in.
            if ((this.sortName === name) && !dir) {
                this.sortDir = (this.sortDir === 'asc') ? 'desc' : 'asc';
            } else {
                this.sortDir = dir || 'asc';
            }

            // Track the sort property
            this.sortName = name;

            // Default to not sort automatically
            doSort = doSort || false;

            // Set the comparator and fire off a sort
            this.comparator = this.strategies(this.sortDir)(this.sortName);

            // Should we fired off a sort right away
            if (doSort) this.sort();
        },
        /**
         * [sync description]
         * @param  {[type]} method     [description]
         * @param  {[type]} collection [description]
         * @param  {[type]} options    [description]
         * @return {[type]}            [description]
         */
        sync: function (method, collection, options) {

            // Attach additional querystring params for GET requests
            if (method === 'read') {
                options = options || {};
                options.data = _.extend(options.data || {}, this.query);
            }

            return Backbone.sync(method, collection, options);
        }
    });

    // Export module
    return BackboneExtras;
}));
