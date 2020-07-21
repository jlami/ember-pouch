import { assert } from '@ember/debug';
import { isEmpty } from '@ember/utils';
import { all, defer } from 'rsvp';
import { get } from '@ember/object';
import { getOwner } from '@ember/application';
import { bind } from '@ember/runloop';
import { on } from '@ember/object/evented';
import { classify, camelize } from '@ember/string';
import DS from 'ember-data';
import { pluralize } from 'ember-inflector';
//import BelongsToRelationship from 'ember-data/-private/system/relationships/state/belongs-to';

import {
  extractDeleteRecord,
  shouldSaveRelationship,
  configFlagDisabled
} from '../utils';

//BelongsToRelationship.reopen({
//  findRecord() {
//    return this._super().catch(() => {
//      //not found: deleted
//      this.clear();
//    });
//  }
//});

export default DS.RESTAdapter.extend({
  fixDeleteBug: true,
  coalesceFindRequests: false,

  // The change listener ensures that individual records are kept up to date
  // when the data in the database changes. This makes ember-data 2.0's record
  // reloading redundant.
  shouldReloadRecord: function () { return false; },
  shouldBackgroundReloadRecord: function () { return false; },
  _onInit : on('init', function()  {
    this._startChangesToStoreListener();
  }),
  _startChangesToStoreListener: function() {
    var db = this.get('db');
    if (db && !this.changes) { // only run this once
      var onChangeListener = bind(this, 'onChange');
      this.set('onChangeListener', onChangeListener);
      this.changes = db.changes({
        since: 'now',
        live: true,
        returnDocs: false
      });
      this.changes.on('change', onChangeListener);
    }
  },

  _stopChangesListener: function() {
    if (this.changes) {
      var onChangeListener = this.get('onChangeListener');
      this.changes.removeListener('change', onChangeListener);
      this.changes.cancel();
      this.changes = undefined;
    }
  },
  changeDb: function(db) {
    this._stopChangesListener();

    var store = this.store;
    var schema = this._schema || [];

    for (var i = 0, len = schema.length; i < len; i++) {
      store.unloadAll(schema[i].singular);
    }

    this._schema = null;
    this.set('db', db);
    this._startChangesToStoreListener();
  },
  onChange: function (change) {
    // If relational_pouch isn't initialized yet, there can't be any records
    // in the store to update.
    if (!this.get('db').rel) { return; }

    var obj = this.get('db').rel.parseDocID(change.id);
    // skip changes for non-relational_pouch docs. E.g., design docs.
    if (!obj.type || !obj.id || obj.type === '') { return; }

    var store = this.store;

    if (this.waitingForConsistency[change.id]) {
      let promise = this.waitingForConsistency[change.id];
      delete this.waitingForConsistency[change.id];
      if (change.deleted) {
        promise.reject("deleted");
      } else {
        promise.resolve(this._findRecord(obj.type, obj.id));
      }
      return;
    }

    try {
      store.modelFor(obj.type);
    } catch (e) {
      // The record refers to a model which this version of the application
      // does not have.
      //TODO: @m2m handle m2m records
      return;
    }

    var recordInStore = store.peekRecord(obj.type, obj.id);
    if (!recordInStore) {
      // The record hasn't been loaded into the store; no need to reload its data.
      if (this.createdRecords[obj.id]) {
        delete this.createdRecords[obj.id];
      } else {
        this.unloadedDocumentChanged(obj);
      }
      return;
    }
    if (!recordInStore.get('isLoaded') || recordInStore.get('rev') === change.changes[0].rev || recordInStore.get('hasDirtyAttributes')) {
      // The record either hasn't loaded yet or has unpersisted local changes.
      // In either case, we don't want to refresh it in the store
      // (and for some substates, attempting to do so will result in an error).
      // We also ignore the change if we already have the latest revision
      return;
    }

    if (change.deleted) {
      if (this.fixDeleteBug) {
        recordInStore._internalModel.transitionTo('deleted.saved');//work around ember-data bug
      } else {
        store.unloadRecord(recordInStore);
      }
    } else {
      recordInStore.reload();
    }
  },

  unloadedDocumentChanged: function(/* obj */) {
    /*
     * For performance purposes, we don't load records into the store that haven't previously been loaded.
     * If you want to change this, subclass this method, and push the data into the store. e.g.
     *
     *  let store = this.get('store');
     *  let recordTypeName = this.getRecordTypeName(store.modelFor(obj.type));
     *  this.get('db').rel.find(recordTypeName, obj.id).then(function(doc){
     *    store.pushPayload(recordTypeName, doc);
     *  });
     */
  },

  willDestroy: function() {
    this._stopChangesListener();
  },
  
  init() {
    this._indexPromises = [];
    this.waitingForConsistency = {};
    this.createdRecords = {};
  },
  
  _indexPromises: null,

  _init: function (store, type, indexPromises) {
    var self = this,
        recordTypeName = this.getRecordTypeName(type);
    if (!this.get('db') || typeof this.get('db') !== 'object') {
      throw new Error('Please set the `db` property on the adapter.');
    }

    if (!get(type, 'attributes').has('rev')) {
      var modelName = classify(recordTypeName);
      throw new Error('Please add a `rev` attribute of type `string`' +
        ' on the ' + modelName + ' model.');
    }

    this._schema = this._schema || [];

    var singular = recordTypeName;
    var plural = pluralize(recordTypeName);

    // check that we haven't already registered this model
    for (var i = 0, len = this._schema.length; i < len; i++) {
      var currentSchemaDef = this._schema[i];
      if (currentSchemaDef.singular === singular) {
        return all(this._indexPromises);
      }
    }

    var schemaDef = {
      singular: singular,
      plural: plural
    };

    if (type.documentType) {
      schemaDef['documentType'] = type.documentType;
    }

    let config = getOwner(this).resolveRegistration('config:environment');
    // else it's new, so update
    this._schema.push(schemaDef);
    // check all the subtypes
    // We check the type of `rel.type`because with ember-data beta 19
    // `rel.type` switched from DS.Model to string
    
    var rels = [];//extra array is needed since type.relationships/byName return a Map that is not iterable
    type.eachRelationship((_relName, rel) => rels.push(rel));
    
    let rootCall = indexPromises == undefined;
    if (rootCall) {
      indexPromises = [];
    }
    
    for (let rel of rels) {
      if (rel.kind !== 'belongsTo' && rel.kind !== 'hasMany') {
        // TODO: support inverse as well
        continue; // skip
      }
      var relDef = {},
          relModel = (typeof rel.type === 'string' ? store.modelFor(rel.type) : rel.type);
      if (relModel) {
        let includeRel = true;
        if (!('options' in rel)) rel.options = {};
        
        if (typeof(rel.options.async) === "undefined") {
          rel.options.async = config.emberPouch && !isEmpty(config.emberPouch.async) ? config.emberPouch.async : true;//default true from https://github.com/emberjs/data/pull/3366
        }
        let options = Object.create(rel.options);
        if (rel.kind === 'hasMany' && !shouldSaveRelationship(self, rel)) {
          let inverse = type.inverseFor(rel.key, store);
          if (inverse) {
            if (inverse.kind === 'belongsTo') {
              indexPromises.push(self.get('db').createIndex({index: { fields: ['data.' + inverse.name, '_id'] }}));
              if (options.async) {
                includeRel = false;
              } else {
                options.queryInverse = inverse.name;
              }
            } else {
              //debugger;
              assert('hasMany relationship expected', inverse.kind === 'hasMany');
              
              //TODO: singularize
              includeRel = false;
              
              let inv2 = inverse.type.inverseFor(inverse.name, store);
        
              let relOrder = rel.name > inverse.name;
              let relA =  relOrder ? inv2 : inverse;
              let relB = !relOrder ? inv2 : inverse;
              
              let name = this.many2manyTableName(relA, relB);
              
              let m2mDef = this._schema.find(x => x.singular === name);
              if (!m2mDef) {
                indexPromises.push(self.get('db').createIndex({index: { fields: ['data.' + relA.name, '_id'] }}));
                indexPromises.push(self.get('db').createIndex({index: { fields: ['data.' + relB.name, '_id'] }}));
                
                let m2mRel = {};
                //TODO: use relA.key here or in index?
                m2mRel[relA.name] = { belongsTo: { type: relA.name, options: { async: true }}};//TODO: async=true and postprocess?
                m2mRel[relB.name] = { belongsTo: { type: relB.name, options: { async: true }}};
                
                m2mDef = {
                  singular: name,
                  plural: name + 's',
                  relations: m2mRel,
                };
                
                this._schema.push(m2mDef);
                
                this._m2mcache[name] = [{}, {}];//array of sides, with map of records by id
              }
            }
          }
        }

        if (includeRel) {
          relDef[rel.kind] = {
            type: self.getRecordTypeName(relModel),
            options: options
          };
          if (!schemaDef.relations) {
            schemaDef.relations = {};
          }
          schemaDef.relations[rel.key] = relDef;
        }
        
        self._init(store, relModel, indexPromises);
      }
    }

    this.get('db').setSchema(this._schema);
    
    if (rootCall) {
      this._indexPromises = this._indexPromises.concat(indexPromises);
      return all(indexPromises).then(() => {
        this._indexPromises = this._indexPromises.filter(x => !indexPromises.includes(x));
      });
    }
  },

  _recordToData: function (store, type, record) {
    var data = {};
    // Though it would work to use the default recordTypeName for modelName &
    // serializerKey here, these uses are conceptually distinct and may vary
    // independently.
    var modelName = type.modelName || type.typeKey;
    var serializerKey = camelize(modelName);
    var serializer = store.serializerFor(modelName);

    serializer.serializeIntoHash(
      data,
      type,
      record,
      {includeId: true}
    );

    data = data[serializerKey];

    // ember sets it to null automatically. don't need it.
    if (data.rev === null) {
      delete data.rev;
    }

    return data;
  },

  /**
   * Return key that conform to data adapter
   * ex: 'name' become 'data.name'
   */
  _dataKey: function(key) {
    var dataKey ='data.' + key;
    return ""+ dataKey + "";
  },

  /**
   * Returns the modified selector key to comform data key
   * Ex: selector: {name: 'Mario'} wil become selector: {'data.name': 'Mario'}
   */
  _buildSelector: function(selector) {
    var dataSelector = {};
    var selectorKeys = [];

    for (var key in selector) {
      if(selector.hasOwnProperty(key)){
        selectorKeys.push(key);
      }
    }

    selectorKeys.forEach(function(key) {
      var dataKey = this._dataKey(key);
      dataSelector[dataKey] = selector[key];
    }.bind(this));

    return dataSelector;
  },

  /**
   * Returns the modified sort key
   * Ex: sort: ['series'] will become ['data.series']
   * Ex: sort: [{series: 'desc'}] will became [{'data.series': 'desc'}]
   */
  _buildSort: function(sort) {
    return sort.map(function (value) {
      var sortKey = {};
      if (typeof value === 'object' && value !== null) {
        for (var key in value) {
          if(value.hasOwnProperty(key)){
            sortKey[this._dataKey(key)] = value[key];
          }
        }
      } else {
        return this._dataKey(value);
      }
      return sortKey;
    }.bind(this));
  },

  /**
   * Returns the string to use for the model name part of the PouchDB document
   * ID for records of the given ember-data type.
   *
   * This method uses the camelized version of the model name in order to
   * preserve data compatibility with older versions of ember-pouch. See
   * pouchdb-community/ember-pouch#63 for a discussion.
   *
   * You can override this to change the behavior. If you do, be aware that you
   * need to execute a data migration to ensure that any existing records are
   * moved to the new IDs.
   */
  getRecordTypeName(type) {
    return camelize(type.modelName);
  },

  findAll: async function(store, type /*, sinceToken */) {
    // TODO: use sinceToken
    await this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type));
  },

  findMany: async function(store, type, ids) {
    await this._init(store, type);
    return this.get('db').rel.find(this.getRecordTypeName(type), ids);
  },
  
  many2manyTableName(relA, relB) {
    return relA.type.modelName + "2" + relB.type.modelName;
  },

  findHasMany: async function(store, record, link, rel) {
    await this._init(store, record.type);
    let inverse = record.type.inverseFor(rel.key, store);
    if (inverse) {
      if (inverse.kind === 'belongsTo') {
        return this.get('db').rel.findHasMany(camelize(rel.type), inverse.name, record.id);
      } else if (inverse.kind === 'hasMany') {
        //debugger;
        let inv2 = inverse.type.inverseFor(inverse.name, store);
        
        let relOrder = rel.name > inverse.name;
        let relA =  relOrder ? inv2 : inverse;
        let relB = !relOrder ? inv2 : inverse;
        
        let helperTableName = this.many2manyTableName(relA, relB);
        if (helperTableName) {
          let helperData = await this.get('db').rel.findHasMany(helperTableName, inverse.name, record.id);
          
          //return this.findMany(store, inverse.type, )//can't only load side B because this will mark B.toA as loaded without having all the data
          let result = {};
          result._m2m = {};
          let relationships = {};
          let typeName = this.getRecordTypeName(record.type);
          relationships[pluralize(rel.type)] = (helperData[helperTableName+'s'] || []).map(x => { return {type: rel.type, id: x[inv2.name]}; });
          //result._m2m.data = [{id: record.id, type: typeName, relationships}];
          
          let modelClass = store.modelFor(rel.type);
          let serializer = store.serializerFor(rel.type);
          //TODO: filter records to load with store.hasRecordForId(typeName, id)
          let response = await this.findMany(store, inverse.type, (helperData[helperTableName+'s'] || []).map(x => x[inv2.name]));
          let normalized = serializer.normalizeArrayResponse(store, modelClass, response, record.id, 'findMany');
  
          result._m2m.included = normalized.data;//TODO: add normalized.included too?
          //[{id: record.id, type: typeName, relationships}];//does not work because ember data expects .data
          //[pluralize(typeName)]

          result._m2m.data = helperData[helperTableName+'s'].map(x => { return {type: rel.type, id: x[inv2.name]}; });
          
          //result[pluralize(rel.type)] = helperData[rel.key] || [];
          //result[pluralize(rel.type)].forEach(x => x[inverse.name] = [record.id]);
          //let many = helperData[helperTableName+'s'].map(x => x[inv2.name]);
          //console.log(many);
          return result;
        }
      }
    }
    
    let result = {};
    result[pluralize(rel.type)] = [];
    return result; //data;
  },

  query: async function(store, type, query) {
    await this._init(store, type);

    var recordTypeName = this.getRecordTypeName(type);
    var db = this.get('db');

    var queryParams = {
      selector: this._buildSelector(query.filter)
    };

    if (!isEmpty(query.sort)) {
      queryParams.sort = this._buildSort(query.sort);
    }

    if (!isEmpty(query.limit)) {
      queryParams.limit = query.limit;
    }

    if (!isEmpty(query.skip)) {
      queryParams.skip = query.skip;
    }

    let pouchRes = await db.find(queryParams);
    return db.rel.parseRelDocs(recordTypeName, pouchRes.docs);
  },

  queryRecord: async function(store, type, query) {
    let results = await this.query(store, type, query);
    let recordType = this.getRecordTypeName(type);
    let recordTypePlural = pluralize(recordType);
    if(results[recordTypePlural].length > 0){
      results[recordType] = results[recordTypePlural][0];
    } else {
      results[recordType] = null;
    }
    delete results[recordTypePlural];
    return results;
  },

  /**
   * `find` has been deprecated in ED 1.13 and is replaced by 'new store
   * methods', see: https://github.com/emberjs/data/pull/3306
   * We keep the method for backward compatibility and forward calls to
   * `findRecord`. This can be removed when the library drops support
   * for deprecated methods.
  */
  find: function (store, type, id) {  
    return this.findRecord(store, type, id);
  },

  findRecord: async function (store, type, id) {
    await this._init(store, type);
    var recordTypeName = this.getRecordTypeName(type);
    return this._findRecord(recordTypeName, id);
  },

  async _findRecord(recordTypeName, id) {
    let payload = await this.get('db').rel.find(recordTypeName, id);
    // Ember Data chokes on empty payload, this function throws
    // an error when the requested data is not found
    if (typeof payload === 'object' && payload !== null) {
      var singular = recordTypeName;
      var plural = pluralize(recordTypeName);

      var results = payload[singular] || payload[plural];
      if (results && results.length > 0) {
        return payload;
      }
    }

    if (configFlagDisabled(this, 'eventuallyConsistent'))
      throw new Error("Document of type '" + recordTypeName + "' with id '" + id + "' not found.");
    else
      return this._eventuallyConsistent(recordTypeName, id);
  },

  //TODO: cleanup promises on destroy or db change?
  waitingForConsistency: null,
  _eventuallyConsistent: function(type, id) {
    let pouchID = this.get('db').rel.makeDocID({type, id});
    let defered = defer();
    this.waitingForConsistency[pouchID] = defered;

    return this.get('db').rel.isDeleted(type, id).then(deleted => {
      //TODO: should we test the status of the promise here? Could it be handled in onChange already?
      if (deleted) {
        delete this.waitingForConsistency[pouchID];
        throw new Error("Document of type '" + type + "' with id '" + id + "' is deleted.");
      } else if (deleted === null) {
        return defered.promise;
      } else {
        assert('Status should be existing', deleted === false);
        //TODO: should we reject or resolve the promise? or does JS GC still clean it?
        if (this.waitingForConsistency[pouchID]) {
          delete this.waitingForConsistency[pouchID];
          return this._findRecord(type, id);
        } else {
          //findRecord is already handled by onChange
          return defered.promise;
        }
      }
    });
  },
  
  _m2mcache: {},
  //TODO: make helper class? m2mRel, with m2m.sideA, m2m.sideB and 2 caches?
  m2mSetCached(tableName, relSide, id, records) {
    this._m2mcache[tableName][relSide][id] = records;
  },
  
  m2mGetCached(tableName, relSide, id) {
    return this._m2mcache[tableName][relSide][id];
  },
  
  m2mAddRecords(records) {
    //filter records that have unsaved ids
    //put batch
    //return array of inserted rows with {id, rev, relAModel, relBModel}
    //relAModel is ref, so save of new record will get correct id
    return [];
  },
  
  async m2mDeleteRecords(m2mName, relSide, cache, id, ids) {
    //should also remove other side
    let deletes = cache.map('id').minus(ids);
    
    //TODO: this is all at once, maybe do some in series, or max X at a time?
    await Promise.all(deletes.map(async x => {
        let inverseCache = m2mGetCached(m2mName, 1-relSide, x[relSide]);
        inverseCache = inverseCache.filter(x => x[1-relSide] == id);
        return await db.delete(x.id, x.rev);
    }));
  },
  
  async m2mCreate(store, type, record) {
    //mark this record as cached
    //foreach m2mrel {
      let many = record.hasMany(relkey).mapBy('record');
      m2mSetCached(tableName, relSide, record.id, many);//will not work after unloadAll?
      
      //can't store only ids, as other side can be 'new' and should be remembered for later
      //otherwise {ids: true} could be 2nd par to record.hasMany
      
      //need to update inverse relationship too :|
    //}
  },
  
  async m2mUpdate(store, type, record) {
    let model = record.record;
    //foreach m2m relationship:
    let cache = m2mGetCached(m2mName, relSide, record.id)
    if (cache) {
      let ids = (await model.get(relName)).mapBy('id');//make sure it is really cached
      //would snapshot.hasMany(relName, {ids: true}) be better?
      
      let inserts = ids.minus(cache);
      
      await this.m2mDeleteRecords(m2mName, relSide, cache, record.id, ids);
      cache = cache.concat(await this.m2mAddRecords(m2mName, relSide, record.id, inserts));
      m2mSetCached(m2mName, relSide, record.id, cache);
    }
  },

  createdRecords: null,
  createRecord: async function(store, type, record) {
    await this._init(store, type);
    var data = this._recordToData(store, type, record);
    let rel = this.get('db').rel;
    
    let id = data.id;
    if (!id) {
      id = data.id = rel.uuid();
    }
    this.createdRecords[id] = true;
    
    let typeName = this.getRecordTypeName(type);
    try {
      let saved = await rel.save(typeName, data);
      Object.assign(data, saved);
      let result = {};
      result[pluralize(typeName)] = [data];
      
      await this.m2mCreate(store, type, record);
      
      return result;
    } catch(e) {
      delete this.createdRecords[id];
      throw e;
    }
  },

  updateRecord: async function (store, type, record) {
    await this._init(store, type);
    var data = this._recordToData(store, type, record);
    let typeName = this.getRecordTypeName(type);
    let saved = await this.get('db').rel.save(typeName, data);
    await this.m2mUpdate(store, type, record);
    Object.assign(data, saved);//TODO: could only set .rev
    let result = {};
    result[pluralize(typeName)] = [data];
    return result;
  },

  deleteRecord: async function (store, type, record) {
    await this._init(store, type);
    //TODO: delete m2m data
    var data = this._recordToData(store, type, record);
    return this.get('db').rel.del(this.getRecordTypeName(type), data)
      .then(extractDeleteRecord);
  }
});
